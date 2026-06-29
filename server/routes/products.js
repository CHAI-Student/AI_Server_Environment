const express = require("express");
const router = express.Router();
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const Minio = require("minio");
const mongoose = require("mongoose");
const axios = require("axios");
// const config = require("../../config/key");
const mime = require("mime-types"); // npm i mime-types (선택이지만 권장)
const archiver = require("archiver");
const unzipper = require("unzipper");
const { PassThrough } = require('stream');

// Helper function for SHA1 hash
function sha1(data) {
  return crypto.createHash("sha1").update(data).digest("hex").slice(0, 8);
}

// Helper function: GPU 서버로 어노테이션 완료 알림 전송
async function notifyGPUServer(folderName) {
  try {
    // folderName format: {divisionIdx}_{storageType}_{trainingProductIdx}_{productIdx}
    const parts = folderName.split('_').filter((p) => p !== '');

    // for (const p of parts) {
    //   if (!/^\d+$/.test(p) && !/^P\d+$/.test(p)) {
    //     divisionIdx = p;
    //     break;
    //   }
    // }
    // if (!divisionIdx && parts.length >= 1) divisionIdx = parts[0];
    const divisionIdx = parts[0];

    // storageType 추출: 2번째 요소 사용
    const storageType = parts[1]; // 명시적 일치 대신 고정 위치에서 추출
    const productIdx = parts[3]; // productIdx는 4번째 요소로 고정

    let isCold;
    if (storageType === 'C') isCold = 'TRUE';
    else if (storageType === 'F') isCold = 'FALSE';
    else {
      console.error('[GPU_NOTIFY] storageType not recognized in folderName:', folderName);
      return;
    }

    // 시스템 ID/날짜 생성
    const now = new Date();
    const dateStr = String(now.getFullYear()).slice(-2) +
                    String(now.getMonth() + 1).padStart(2, '0') +
                    String(now.getDate()).padStart(2, '0');
    const timeStr = String(now.getHours()).padStart(2, '0') +
                    String(now.getMinutes()).padStart(2, '0') +
                    String(now.getSeconds()).padStart(2, '0');
    const ifSysId = `WEB-${dateStr}-${Math.floor(Math.random() * 999999).toString().padStart(6, '0')}`;
    const ifDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${timeStr}`;

    const payload = {
      HEADER: {
        IF_ID: 'IF_WEB_01',
        IF_SYSID: ifSysId,
        IF_HOST: 'WEB',
        IF_DATE: ifDate,
      },
      DATA: {
        division_idx: divisionIdx,
        product_idx: productIdx,
        is_cold: isCold,
      },
    };

    const response = await axios.post('http://139.150.8.82:2140/v1/events/annotation/completed', payload, {
      timeout: 5000,
    });

    console.log('[GPU_NOTIFY] Success:', response.data);
    console.log('[GPU_NOTIFY] Payload sent:', payload);
    return response.data;
  } catch (e) {
    console.error('[GPU_NOTIFY] Error:', e?.message || String(e));
  }
}

//=================================
//        Product Upload
//=================================

// multer: 메모리로 받아서 MinIO로 바로 업로드
// const upload = multer({ storage: multer.memoryStorage() }).array("files", 2000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5000,                 // 상한선
    fileSize: 100 * 1024 * 1024, // 100MB
  },
}).array("files", 2000);

function safe(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isEmptyDir(dir) {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function removeDirIfEmpty(dir) {
  try {
    if (isEmptyDir(dir)) fs.rmdirSync(dir);
  } catch {}
}

function putObjectAsync(minioClient, bucket, key, buffer, meta) {
  return new Promise((resolve, reject) => {
    minioClient.putObject(bucket, key, buffer, meta, (err, etag) => {
      if (err) return reject(err);
      resolve(etag);
    });
  });
}

//=================================
//       MinIO Image Upload
//=================================
// 이미지 업로드
router.post("/uploads/images", (req, res) => {

    console.log('req', req.body)

    upload(req, res, async (err) => {
      try {
        if (err) return res.status(400).json({ success: false, err: String(err) });
        if (!req.files || req.files.length === 0) {
          return res.status(400).json({ success: false, err: "No files uploaded" });
        }

        const minioClient = req.app.locals.minioClient;
        const BUCKET = req.app.locals.minioBucket || "chaiimage";
        if (!minioClient) {
          return res.status(500).json({ success: false, err: "minioClient not initialized in index.js" });
        }

        const productIdx = req.body.productIdx;
        const divisionIdx = req.body.divisionIdx; // 유지해도 되고, 안 쓰면 제거해도 됨
        if (!productIdx || !divisionIdx) {
          return res.status(400).json({ success: false, err: "productIdx and divisionIdx are required" });
        }

        // ✅ 날짜_시간 폴더명은 body로 받자
        const rootName = req.body.rootName; // 예: "20260122_170612"
        if (!rootName) {
          return res.status(400).json({ success: false, err: "rootName is required (e.g., 날짜_시간)" });
        }

        // ✅ files와 같은 개수/순서로 상대경로를 받는다
        const relPaths = req.body.relPaths;
        const relPathArr =
          Array.isArray(relPaths) ? relPaths :
          typeof relPaths === "string" ? [relPaths] : [];

        const useRelPath = relPathArr.length === req.files.length;
        if (!useRelPath) {
          return res.status(400).json({
            success: false,
            err: "relPaths is required and must match files count (e.g., images/cam_0/0001.jpg)",
          });
        }

        // ✅ 최종 상위 폴더: productImg/<productIdx>_<날짜_시간>/
        const foldername = `${safe(productIdx)}_${safe(rootName)}`;
        const basePrefix = `productImg/${foldername}`;
        const folderpath = `s3://${BUCKET}/${basePrefix}/`;

        // putObjectAsync는 minioClient를 인자로 받는 형태로 추천
        const uploaded = await Promise.all(
          req.files.map(async (f, i) => {
            // relPath 예: "images/cam_0/0001.jpg"
            const p = String(relPathArr[i]).replace(/\\/g, "/");

            // ✅ images/ 제거 후 cam_x/... 유지
            let rel = p.startsWith("images/") ? p.slice("images/".length) : p;

            // 보안: 상위 디렉토리 이동 방지
            rel = rel.replace(/^\/*/, "");       // leading slash 제거
            rel = rel.replace(/\.\./g, "_");     // .. 제거

            // 확장자는 rel에서 가져오되, 없으면 f.originalname으로 보정
            const ext = path.extname(rel) || path.extname(f.originalname || "") || ".jpg";
            const withoutExt = ext ? rel.slice(0, -ext.length) : rel;

            // ✅ 최종 key: based_image/<productIdx>_<rootName>/<cam_x/...>_<hash>.jpg
            const key = `${basePrefix}/${withoutExt}_${sha1(f.buffer)}${ext.toLowerCase()}`;

            const meta = { "Content-Type": f.mimetype || "application/octet-stream" };

            // ✅ putObjectAsync(minioClient, BUCKET, key, ...)
            const etag = await putObjectAsync(minioClient, BUCKET, key, f.buffer, meta);

            return { key, etag, size: f.size, mimeType: f.mimetype };
          })
        );

        return res.json({
          success: true,
          bucket: BUCKET,
          foldername,
          folderpath,
          filelength: uploaded.length,
          objects: uploaded.map((x) => ({ key: x.key, etag: x.etag, size: x.size })),
        });
      } catch (e) {
        return res.status(500).json({ success: false, err: e?.message || String(e) });
      }
    });

});

// 리뷰용 이미지 리스트 가져오기
router.get("/review/images", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) {
      return res.status(500).json({ success: false, err: "minioClient not initialized" });
    }

    // 예: productImg/123_20260122_170612/done/ 처럼 완료 폴더를 쓰면 prefix로 받기
    const prefix = (req.query.prefix || "").toString(); // ""면 버킷 전체(비추)
    const recursive = String(req.query.recursive || "true") === "true";

    const items = [];
    const stream = minioClient.listObjectsV2(BUCKET, prefix, recursive);

    stream.on("data", (obj) => {
      if (!obj?.name) return;
      if (!obj.name.match(/\.(png|jpg|jpeg|webp)$/i)) return;

      items.push({
        key: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
      });
    });

    stream.on("error", (err) => {
      return res.status(500).json({ success: false, err: String(err) });
    });

    stream.on("end", () => {
      return res.json({ success: true, bucket: BUCKET, prefix, items });
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// 리뷰용 이미지 다운로드
router.get("/review/folder/download-zip", async (req, res) => {
  const prefix = (req.query.prefix || "").toString();
  if (!prefix) return res.status(400).json({ success: false, err: "prefix is required" });

  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) return res.status(500).json({ success: false, err: "minioClient not initialized" });

    const zipName =
      (req.query.name || prefix.replace(/\/+$/, "").split("/").pop() || "folder") + ".zip";

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Cache-Control", "no-store");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try { res.status(500).end(String(err)); } catch {}
    });

    // 응답 스트림에 zip 연결
    archive.pipe(res);

    // prefix 아래 object 리스트업
    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);

    const addObjectToZip = (key) =>
      new Promise((resolve, reject) => {
        minioClient.getObject(BUCKET, key, (err, objStream) => {
          if (err) return reject(err);

          // zip 안에서는 prefix를 제거해서 상대경로로 담기
          const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          if (!rel || rel.endsWith("/")) return resolve(); // 폴더 엔트리 무시

          objStream.on("error", reject);

          // 파일명 중간에 이상한 문자 들어갈 수 있으니 방어(선택)
          const safeRel = rel.replace(/\\/g, "/").replace(/^\/*/, "").replace(/\.\./g, "_");

          archive.append(objStream, { name: safeRel });
          resolve();
        });
      });

    const tasks = [];
    stream.on("data", (obj) => {
      if (!obj?.name) return;
      // 폴더 엔트리 방지
      if (obj.name.endsWith("/")) return;
      tasks.push(addObjectToZip(obj.name));
    });

    stream.on("error", async (err) => {
      try { await archive.abort(); } catch {}
      return res.status(500).end(String(err));
    });

    stream.on("end", async () => {
      try {
        await Promise.all(tasks);
        await archive.finalize();
      } catch (e) {
        try { await archive.abort(); } catch {}
        // 이미 헤더 보냈으면 json 못 보냄 → 그냥 종료
        try { res.end(String(e)); } catch {}
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});


// 리뷰용 이미지 덮어쓰기
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 예: 500MB 제한(상황 맞게 조정)
}).single("zip");

router.post("/review/folder/upload-zip-overwrite", (req, res) => {
  uploadZip(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ success: false, err: String(err) });

      const minioClient = req.app.locals.minioClient;
      const BUCKET = req.app.locals.minioBucket || "chaiimage";
      if (!minioClient) return res.status(500).json({ success: false, err: "minioClient not initialized" });

      const prefix = (req.body.prefix || "").toString();
      if (!prefix) return res.status(400).json({ success: false, err: "prefix is required" });

      if (!req.file?.buffer) return res.status(400).json({ success: false, err: "zip file is required (field name: zip)" });

      // zip 풀어서 엔트리별로 putObject(같은 key로 overwrite)
      const directory = await unzipper.Open.buffer(req.file.buffer);

      // 보안: prefix 밖으로 탈출(../) 방지
      const normalizeRel = (p) =>
        String(p || "")
          .replace(/\\/g, "/")
          .replace(/^\/*/, "")
          .replace(/\.\./g, "_");

      let uploadedCount = 0;

      for (const entry of directory.files) {
        if (entry.type !== "File") continue;

        const rel = normalizeRel(entry.path);
        if (!rel) continue;

        const key = `${prefix.replace(/\/+$/, "")}/${rel}`;

        const contentType = mime.lookup(rel) || "application/octet-stream";

        // entry.stream()은 ReadableStream
        await new Promise((resolve, reject) => {
          minioClient.putObject(
            BUCKET,
            key,
            entry.stream(),
            { "Content-Type": contentType },
            (e, etag) => {
              if (e) return reject(e);
              uploadedCount += 1;
              resolve(etag);
            }
          );
        });
      }

      return res.json({ success: true, bucket: BUCKET, prefix, uploadedCount });
    } catch (e) {
      return res.status(500).json({ success: false, err: e?.message || String(e) });
    }
  });
});



//=================================
//      MongoDB Meta Save
//=================================
router.post("/products", async (req, res) => {
    try {
        const { productIdx, divisionIdx, foldername, folderpath } = req.body;

        if (!productIdx || !divisionIdx) {
            return res.status(400).json({ success: false, err: "productIdx and divisionIdx are required" });
        }
        if (!foldername || !folderpath) {
            return res.status(400).json({ success: false, err: "foldername and folderpath are required" });
        }

        const doc = await ProductUpload.create({
            productIdx,
            divisionIdx,
            modelVersion: req.body.modelVersion,
            brunchName: req.body.brunchName,
            productName: req.body.productName,
            categoryIdx: req.body.categoryIdx,
            isNew: req.body.isNew,
            trainingStatus: req.body.trainingStatus,
            productEngName: req.body.productEngName,
            productLoadcellWeight: req.body.productLoadcellWeight,
            productAnnotation: req.body.productAnnotation,

            foldername,
            folderpath,
            filelength: Number(req.body.filelength || 0),

            eventPromotion: Array.isArray(req.body.eventPromotion) ? req.body.eventPromotion : [],
        });

        return res.json({ success: true, id: doc._id });
    } catch (e) {
        return res.status(500).json({ success: false, err: e?.message || String(e) });
    }
});

//=================================
//   Annotation Review (검수용)
//=================================

// NewAnnotation 경로의 모든 폴더 목록 조회
// 폴더 구조 파싱: /NewAnnotation/{divisionIdx}_{trainingProductIdx}_{productIdx}
router.get("/annotation/list-all", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) {
      return res.status(500).json({ success: false, err: "minioClient not initialized" });
    }

    const prefix = "NewAnnotation/";
    const folderMap = new Map(); // {folderName: {count, size}}

    const stream = minioClient.listObjectsV2(BUCKET, prefix, false); // non-recursive로 폴더만 조회

    stream.on("data", (obj) => {
      // MinIO may return either { name: '…' } or { prefix: '…' } when recursive is false
      const key = obj.name || obj.prefix;
      if (!key || !key.startsWith(prefix)) return;

      // /NewAnnotation/D001_T001_P123/ 형태에서 D001_T001_P123 추출
      const rel = key.slice(prefix.length);
      const folderName = rel.split("/")[0];

      if (folderName && folderName !== "") {
        if (!folderMap.has(folderName)) {
          folderMap.set(folderName, { name: folderName, files: [], totalSize: 0 });
        }
      }
    });

    stream.on("error", (err) => {
      return res.status(500).json({ success: false, err: String(err) });
    });

    stream.on("end", async () => {
      // 각 폴더 내 파일 개수 및 크기 계산
      const folders = [];

      for (const [folderName, folderInfo] of folderMap) {
        const folderPrefix = `${prefix}${folderName}`;
        let fileCount = 0;
        let totalSize = 0;

        const fileStream = minioClient.listObjectsV2(BUCKET, folderPrefix, true);

        await new Promise((resolve, reject) => {
          fileStream.on("data", (obj) => {
            if (obj?.name && !obj.name.endsWith("/")) {
              fileCount++;
              totalSize += obj.size || 0;
            }
          });

          fileStream.on("error", reject);

          fileStream.on("end", () => {
            folders.push({
              folderName,
              prefix: folderPrefix,
              fileCount,
              totalSize,
              createdAt: new Date(),
            });
            resolve();
          });
        });
      }

      // attach product info from ProductsList
      const coll = mongoose.connection.db.collection('ProductsList');
      console.log('[ANNOTATION LIST] Starting folder processing...');
      
      await Promise.all(
        folders.map(async (f) => {
          // 폴더 구조: DivisionIdx_StorageType_TrainingIdx_ProductIdx
          const parts = f.folderName.split('_');
          const trainProductIdx = parts[2] || '';
          const productIdx = parts[parts.length - 1] || '';
          
          f.trainingProductIdx = trainProductIdx;
          f.productIdx = productIdx;
          f.productEngName = '';
          
          try {
            // 숫자로만 조회
            const trainProductIdxNum = parseInt(trainProductIdx, 10);
            if (isNaN(trainProductIdxNum)) {
              console.log('[ANNOTATION LIST] Invalid trainProductIdx (not a number):', trainProductIdx);
              return;
            }

            const doc = await coll.findOne(
              { trainProductIdx: trainProductIdxNum },
              { projection: { productEngName: 1, trainProductIdx: 1 } }
            );
            
            if (doc?.productEngName) {
              f.productEngName = doc.productEngName;
              console.log('[ANNOTATION LIST] ✓ Found:', trainProductIdx, '->', doc.productEngName);
            } else {
              console.log('[ANNOTATION LIST] ✗ No match for trainProductIdx:', trainProductIdx);
            }
          } catch (err) {
            console.error('[ANNOTATION LIST] Error querying MongoDB:', trainProductIdx, err.message);
          }
        })
      );

      return res.json({
        success: true,
        bucket: BUCKET,
        prefix,
        folders: folders.sort((a, b) => b.fileCount - a.fileCount),
        totalFolders: folders.length,
      });
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// endpoint for retrieving single product info
router.get('/product/:productIdx', async (req, res) => {
  try {
    const productIdx = (req.params.productIdx || '').toString();
    if (!productIdx) return res.status(400).json({ success: false, err: 'productIdx required' });
    const coll = mongoose.connection.db.collection('ProductsList');
    const doc = await coll.findOne({ productIdx });
    if (!doc) return res.status(404).json({ success: false, err: 'not found' });
    return res.json({ success: true, product: doc });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});



// 특정 어노테이션 폴더 다운로드 (Zip)
router.get("/annotation/download-zip", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) {
      return res.status(500).json({ success: false, err: "minioClient not initialized" });
    }

    const folderName = (req.query.folderName || "").toString();
    if (!folderName) {
      return res.status(400).json({ success: false, err: "folderName is required" });
    }

    const prefix = `NewAnnotation/${folderName}`;
    const zipName = `${folderName}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Cache-Control", "no-store");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try { res.status(500).end(String(err)); } catch {}
    });

    archive.pipe(res);

    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);

    const addObjectToZip = (key) =>
      new Promise((resolve, reject) => {
        minioClient.getObject(BUCKET, key, (err, objStream) => {
          if (err) return reject(err);

          const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          if (!rel || rel.endsWith("/")) return resolve();

          objStream.on("error", reject);
          const safeRel = rel.replace(/\\/g, "/").replace(/^\/*/, "").replace(/\.\./g, "_");
          archive.append(objStream, { name: safeRel });
          resolve();
        });
      });

    const tasks = [];
    stream.on("data", (obj) => {
      if (!obj?.name) return;
      if (obj.name.endsWith("/")) return;
      tasks.push(addObjectToZip(obj.name));
    });

    stream.on("error", async (err) => {
      try { await archive.abort(); } catch {}
      return res.status(500).end(String(err));
    });

    stream.on("end", async () => {
      try {
        await Promise.all(tasks);
        await archive.finalize();
      } catch (e) {
        try { await archive.abort(); } catch {}
        try { res.end(String(e)); } catch {}
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// 모든 AnnotationLabel 컬렉션의 내용을 JSON 파일로 내려받기
router.get("/annotation/download-labels", async (req, res) => {
  try {
    const db = mongoose.connection.db;
    if (!db) return res.status(500).json({ success: false, err: 'mongodb not initialized' });
    const coll = db.collection('AnnotationLabel');
    // 안전하게 비어있을 경우 빈 배열 반환
    const docs = await coll.find({}).toArray();

    // 재귀적으로 ObjectId나 {$oid: '...'} 같은 구조를 문자열로 바꿔줍니다.
    const sanitize = (val) => {
      if (val === null || val === undefined) return val;
      if (Array.isArray(val)) return val.map(sanitize);
      if (typeof val === 'object') {
        if (typeof val.toHexString === 'function') return val.toHexString();
        if (Object.prototype.hasOwnProperty.call(val, '$oid') && Object.keys(val).length === 1 && typeof val.$oid === 'string') return val.$oid;

        const out = {};
        for (const k of Object.keys(val)) {
          out[k] = sanitize(val[k]);
        }
        return out;
      }
      return val;
    };

    const cleaned = docs.map((d) => sanitize(d));

    // Remove MongoDB internal _id field from exported objects
    const withoutId = cleaned.map(({ _id, ...rest }) => rest);

    const filename = 'annotation-labels.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    return res.send(JSON.stringify(withoutId, null, 2));
  } catch (e) {
    return res.status(500).json({ success: false, err: (e && e.message) ? e.message : String(e) });
  }
});

// 검수 완료 후 Zip 업로드
const uploadZipAnnotation = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
}).single("zip");

router.post("/annotation/upload-verified", (req, res) => {
  uploadZipAnnotation(req, res, async (err) => {
    // 요청이 들어왔음을 빠르게 찍어둠
    console.log('[UPLOAD_HANDLER] request received');

    let clientAborted = false;
    let uploadParser = null;
    let bufferStream = null;
    let minioClient = null;
    let BUCKET = null;
    let uploadPrefix = null;
    let cleanupInProgress = false;
    const activeTmpStreams = new Set();

    const cleanupUploadPrefix = async () => {
      if (cleanupInProgress || !minioClient || !BUCKET || !uploadPrefix) return;
      cleanupInProgress = true;
      try {
        const cleanupPrefix = uploadPrefix.replace(/\/+$/, '') + '/';
        const deleteKeys = [];
        const deleteStream = minioClient.listObjectsV2(BUCKET, cleanupPrefix, true);

        await new Promise((resolve, reject) => {
          deleteStream.on('data', (obj) => {
            if (!obj?.name || obj.name.endsWith('/')) return;
            deleteKeys.push(obj.name);
          });
          deleteStream.on('error', reject);
          deleteStream.on('end', resolve);
        });

        if (deleteKeys.length > 0) {
          await Promise.all(
            deleteKeys.map(
              (key) =>
                new Promise((resolve) => {
                  minioClient.removeObject(BUCKET, key, (err) => {
                    if (err) console.warn('[UPLOAD_HANDLER] cleanup removeObject failed:', key, err.message || err);
                    resolve();
                  });
                })
            )
          );
          console.warn('[UPLOAD_HANDLER] aborted upload cleanup completed:', deleteKeys.length, 'objects deleted');
        }
      } catch (cleanupErr) {
        console.error('[UPLOAD_HANDLER] cleanup failed for aborted upload:', uploadPrefix, cleanupErr.message || cleanupErr);
      }
    };

    const abortHandler = () => {
      if (clientAborted) return;
      clientAborted = true;
      console.warn('[UPLOAD_HANDLER] request aborted by client');
      if (uploadParser && !uploadParser.destroyed) {
        try {
          uploadParser.destroy(new Error('client aborted'));
        } catch (e) {
          console.warn('[UPLOAD_HANDLER] parser destroy failed:', e.message || e);
        }
      }
      if (bufferStream && !bufferStream.destroyed) {
        try {
          bufferStream.destroy(new Error('client aborted'));
        } catch (e) {
          console.warn('[UPLOAD_HANDLER] bufferStream destroy failed:', e.message || e);
        }
      }
      for (const tmp of activeTmpStreams) {
        try {
          tmp.destroy(new Error('client aborted'));
        } catch (e) {
          console.warn('[UPLOAD_HANDLER] tmp destroy failed:', e.message || e);
        }
      }
      activeTmpStreams.clear();
      cleanupUploadPrefix().catch((e) => {
        console.error('[UPLOAD_HANDLER] abort cleanup error:', e.message || e);
      });
    };

    req.on('aborted', abortHandler);
    req.on('close', abortHandler);

    try {
      if (err) {
        console.error("[UPLOAD ERROR] Multer error:", err);
        if (clientAborted) return;
        return res.status(400).json({ success: false, err: String(err) });
      }

      minioClient = req.app.locals.minioClient;
      BUCKET = req.app.locals.minioBucket || "chaiimage";
      if (!minioClient) {
        if (clientAborted) return;
        return res.status(500).json({ success: false, err: "minioClient not initialized" });
      }

      const folderName = (req.body.folderName || "").toString();
      if (!folderName) {
        if (clientAborted) return;
        return res.status(400).json({ success: false, err: "folderName is required" });
      }

      if (!req.file?.buffer) {
        console.error("[UPLOAD ERROR] No file buffer received");
        if (clientAborted) return;
        return res.status(400).json({ success: false, err: "zip file is required (field name: zip)" });
      }

      console.log(`[UPLOAD] File received. Size: ${req.file.buffer.length} bytes, Original name: ${req.file.originalname}`);

      const trainProductIdx = (req.body.trainProductIdx || "").toString();
      const productEngName = (req.body.productEngName || "").toString();

      if (!trainProductIdx || !productEngName) {
        if (clientAborted) return;
        return res.status(400).json({
          success: false,
          err: "trainProductIdx and productEngName are required",
        });
      }

      // 새로운 업로드 경로
      const now = new Date();
      // format as YYYYMMDD_HHMMSS (year-month-day _ hour-minute-second)
      const pad = (n) => String(n).padStart(2, "0");
      const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const dateTimeStr = `${date}_${time}`;

      uploadPrefix = `productAnnotation/${trainProductIdx}_${productEngName}_${dateTimeStr}`;

      // Zip 풀어서 업로드 (streaming parse 사용)
      const normalizeRel = (p) =>
        String(p || "")
          .replace(/\\/g, "/")
          .replace(/^\/*/, "")
          .replace(/\.\./g, "_");

      bufferStream = new PassThrough();
      bufferStream.on('error', (e) => {
        if (clientAborted) return;
        streamErr = e;
      });
      bufferStream.end(req.file.buffer);

      let uploadedCount = 0;
      let pending = 0;
      let streamErr = null;
      let skippedFiles = []; // zero-length or errors

      await new Promise((resolve, reject) => {
        uploadParser = bufferStream.pipe(unzipper.Parse());

        uploadParser.on('entry', (entry) => {
          if (clientAborted) {
            entry.autodrain();
            return;
          }

          if (streamErr) {
            entry.autodrain();
            return;
          }

          if (entry.type !== 'File') {
            entry.autodrain();
            return;
          }

          const rel = normalizeRel(entry.path);
          if (!rel) {
            entry.autodrain();
            return;
          }

          // Note: do not skip based on entry.vars here; we'll inspect actual stream bytes
          // to determine zero-length entries. Some archives report 0 in metadata
          // even though data exists, so rely on streaming bytes instead.

          const key = `${uploadPrefix}/${rel}`;
          const contentType = mime.lookup(rel) || 'application/octet-stream';

          pending += 1;
          // console.log(`[ZIP_UPLOAD] processing entry ${entry.path} size=${entry.vars?.uncompressedSize || '?'} compressed=${entry.vars?.compressedSize || '?'} `);
          try {
            const tmp = new PassThrough();
            activeTmpStreams.add(tmp);
            tmp.on('error', (e) => {
              if (clientAborted) return;
              streamErr = e;
            });
            let totalBytes = 0;
            let entryCanceled = false;

            entry.on('data', (chunk) => {
              if (clientAborted) {
                entryCanceled = true;
                try { entry.destroy(new Error('client aborted')); } catch (e) {}
                return;
              }
              totalBytes += chunk.length;
              tmp.write(chunk);
            });

            entry.on('end', () => {
              if (clientAborted || entryCanceled) {
                tmp.destroy(new Error('client aborted'));
                activeTmpStreams.delete(tmp);
                pending -= 1;
                return;
              }

              tmp.end();

              if (totalBytes === 0) {
                console.warn('[ZIP_UPLOAD] skipping zero-length file (stream) ', entry.path);
                skippedFiles.push(entry.path);
                activeTmpStreams.delete(tmp);
                pending -= 1;
                return;
              }

              try {
                minioClient.putObject(BUCKET, key, tmp, { 'Content-Type': contentType }, (e, etag) => {
                  activeTmpStreams.delete(tmp);
                  pending -= 1;
                  if (clientAborted) {
                    tmp.destroy(new Error('client aborted'));
                    return;
                  }
                  if (e) {
                    console.error(`[ZIP_UPLOAD] putObject error for ${entry.path}:`, e.message);
                    if (e.message && e.message.includes('You must specify at least one part')) {
                      console.warn(`[ZIP_UPLOAD] skipping empty entry ${entry.path}`);
                      return;
                    }
                    streamErr = e;
                    return reject(e);
                  }
                  uploadedCount += 1;
                  // console.log(`[ZIP_UPLOAD] uploaded ${entry.path}`);
                });
              } catch (e) {
                activeTmpStreams.delete(tmp);
                pending -= 1;
                streamErr = e;
                return reject(e);
              }
            });

            entry.on('error', (e) => {
              tmp.end();
              pending -= 1;
              streamErr = e;
              return reject(e);
            });
          } catch (e) {
            pending -= 1;
            streamErr = e;
            entry.autodrain();
            return reject(e);
          }
        });

        uploadParser.on('error', (e) => {
          if (clientAborted) return resolve();
          streamErr = e;
          return reject(e);
        });

        uploadParser.on('close', () => {
          if (clientAborted) return resolve();
          if (streamErr) return reject(streamErr);
          const wait = () => {
            if (pending === 0) return resolve();
            setTimeout(wait, 50);
          };
          wait();
        });
      });

      // 클라이언트가 취소했으면 응답하지 않고 업로드된 임시 파일 삭제 후 종료
      if (clientAborted) {
        console.warn('[UPLOAD_HANDLER] client aborted before response, cleaning up uploaded prefix:', uploadPrefix);
        try {
          const deleteKeys = [];
          const deleteStream = minioClient.listObjectsV2(BUCKET, uploadPrefix, true);

          await new Promise((resolve, reject) => {
            deleteStream.on('data', (obj) => {
              if (!obj?.name || obj.name.endsWith('/')) return;
              deleteKeys.push(obj.name);
            });
            deleteStream.on('error', reject);
            deleteStream.on('end', resolve);
          });

          if (deleteKeys.length > 0) {
            await Promise.all(
              deleteKeys.map(
                (key) =>
                  new Promise((resolve) => {
                    minioClient.removeObject(BUCKET, key, (err) => {
                      if (err) console.warn('[UPLOAD_HANDLER] cleanup removeObject failed:', key, err.message || err);
                      resolve();
                    });
                  })
              )
            );
            console.warn('[UPLOAD_HANDLER] aborted upload cleanup completed:', deleteKeys.length, 'objects deleted');
          }
        } catch (cleanupErr) {
          console.error('[UPLOAD_HANDLER] cleanup failed for aborted upload:', uploadPrefix, cleanupErr.message || cleanupErr);
        }
        return;
      }

      // 응답 전송
      if (uploadedCount === 0) {
        console.warn('[UPLOAD] no valid files found inside zip', folderName, 'skipped', skippedFiles.length);
        // 디버깅: 서버에 zip 덤프
        try {
          const dumpPath = `/tmp/debug-${Date.now()}.zip`;
          require('fs').writeFileSync(dumpPath, req.file.buffer);
          console.warn('[UPLOAD] dumped zip to', dumpPath);
        } catch (e) {
          console.error('[UPLOAD] failed to dump zip for debugging', e.message);
        }
        return res.status(400).json({
          success: false,
          err: 'ZIP에 업로드할 수 있는 유효한 파일이 없습니다',
          skipped: skippedFiles.slice(0, 10), // 최대 10개 예시
        });
      }

      if (!clientAborted) {
        res.json({
          success: true,
          bucket: BUCKET,
          uploadPrefix,
          uploadedCount,
          folderName,
          skippedCount: skippedFiles.length,
          skipped: skippedFiles.length > 0 ? skippedFiles.slice(0,10) : undefined,
          message: `Uploaded ${uploadedCount} files to ${uploadPrefix}`,
        });

        // 비동기로 GPU 서버에 알림 전송 (응답 후 백그라운드에서 실행)
        setImmediate(() => {
          notifyGPUServer(folderName).catch((e) => {
            console.error('[GPU_NOTIFY] Error notification failed:', e?.message || String(e));
          });
        });
      }
    } catch (e) {
      return res.status(500).json({ success: false, err: e?.message || String(e) });
    }
  });
});

// NewAnnotation 폴더 삭제
router.delete("/annotation/delete-folder", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) return res.status(500).json({ success: false, err: "minioClient not initialized" });

    const folderName = (req.query.folderName || "").toString();
    if (!folderName) {
      return res.status(400).json({ success: false, err: "folderName is required" });
    }

    const prefix = `NewAnnotation/${folderName}`;

    // 폴더 내 모든 파일 삭제
    let deletedCount = 0;
    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);

    const filesToDelete = [];
    stream.on("data", (obj) => {
      if (!obj?.name || obj.name.endsWith("/")) return;
      filesToDelete.push(obj.name);
    });

    stream.on("error", (err) => {
      return res.status(500).json({ success: false, err: String(err) });
    });

    stream.on("end", async () => {
      if (filesToDelete.length > 0) {
        await Promise.all(
          filesToDelete.map(
            (key) =>
              new Promise((resolve) => {
                minioClient.removeObject(BUCKET, key, (err) => {
                  if (!err) deletedCount += 1;
                  resolve();
                });
              })
          )
        );
      }

      return res.json({
        success: true,
        bucket: BUCKET,
        prefix,
        folderName,
        deletedCount,
        message: `Deleted ${deletedCount} files from ${prefix}`,
      });
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// 기존 API들 (호환성 유지)
// 검수 대상 어노테이션 목록 조회
// 경로: /NewAnnotation/{divisionIdx}_{trainingProductIdx}_{ProductIdx}
router.get("/annotation/list-new", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) {
      return res.status(500).json({ success: false, err: "minioClient not initialized" });
    }

    // query params: divisionIdx, trainingProductIdx, productIdx
    const divisionIdx = (req.query.divisionIdx || "").toString();
    const trainingProductIdx = (req.query.trainingProductIdx || "").toString();
    const productIdx = (req.query.productIdx || "").toString();

    if (!divisionIdx || !trainingProductIdx || !productIdx) {
      return res.status(400).json({
        success: false,
        err: "divisionIdx, trainingProductIdx, productIdx are required",
      });
    }

    // prefix 구성: /NewAnnotation/{divisionIdx}_{trainingProductIdx}_{ProductIdx}
    const prefix = `NewAnnotation/${divisionIdx}_${trainingProductIdx}_${productIdx}`;

    const items = [];
    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);

    stream.on("data", (obj) => {
      if (!obj?.name) return;
      // 폴더 엔트리 제외
      if (obj.name.endsWith("/")) return;

      items.push({
        key: obj.name,
        size: obj.size,
        lastModified: obj.lastModified,
        etag: obj.etag,
      });
    });

    stream.on("error", (err) => {
      return res.status(500).json({ success: false, err: String(err) });
    });

    stream.on("end", () => {
      return res.json({
        success: true,
        bucket: BUCKET,
        prefix,
        folderName: `${divisionIdx}_${trainingProductIdx}_${productIdx}`,
        items,
        count: items.length,
      });
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// 검수 대상 어노테이션 Zip 다운로드
router.get("/annotation/download-new-zip", async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || "chaiimage";
    if (!minioClient) {
      return res.status(500).json({ success: false, err: "minioClient not initialized" });
    }

    // query params
    const divisionIdx = (req.query.divisionIdx || "").toString();
    const trainingProductIdx = (req.query.trainingProductIdx || "").toString();
    const productIdx = (req.query.productIdx || "").toString();

    if (!divisionIdx || !trainingProductIdx || !productIdx) {
      return res.status(400).json({
        success: false,
        err: "divisionIdx, trainingProductIdx, productIdx are required",
      });
    }

    const prefix = `NewAnnotation/${divisionIdx}_${trainingProductIdx}_${productIdx}`;
    const zipName = `${divisionIdx}_${trainingProductIdx}_${productIdx}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    res.setHeader("Cache-Control", "no-store");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try { res.status(500).end(String(err)); } catch {}
    });

    archive.pipe(res);

    // MinIO에서 prefix 아래 파일 조회
    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);

    const addObjectToZip = (key) =>
      new Promise((resolve, reject) => {
        minioClient.getObject(BUCKET, key, (err, objStream) => {
          if (err) return reject(err);

          // zip 내에서는 prefix 제거하고 상대경로로 저장
          const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
          if (!rel || rel.endsWith("/")) return resolve();

          objStream.on("error", reject);

          const safeRel = rel.replace(/\\/g, "/").replace(/^\/*/, "").replace(/\.\./g, "_");
          archive.append(objStream, { name: safeRel });
          resolve();
        });
      });

    const tasks = [];
    stream.on("data", (obj) => {
      if (!obj?.name) return;
      if (obj.name.endsWith("/")) return;
      tasks.push(addObjectToZip(obj.name));
    });

    stream.on("error", async (err) => {
      try { await archive.abort(); } catch {}
      return res.status(500).end(String(err));
    });

    stream.on("end", async () => {
      try {
        await Promise.all(tasks);
        await archive.finalize();
      } catch (e) {
        try { await archive.abort(); } catch {}
        try { res.end(String(e)); } catch {}
      }
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});

// 검수 완료 어노테이션 업로드 및 원본 삭제 (기존 - deprecated)
// POST body:
//   - divisionIdx, trainingProductIdx, productIdx (원본 경로)
//   - trainProductIdx, productEngName (새 경로용) 또는 uploadPrefix 직접 지정
//   - zip file (field name: "zip")
const uploadZipAnnotationDeprecated = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
}).single("zip");

router.post("/annotation/upload-verified-with-delete", (req, res) => {
  uploadZipAnnotationDeprecated(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ success: false, err: String(err) });

      const minioClient = req.app.locals.minioClient;
      const BUCKET = req.app.locals.minioBucket || "chaiimage";
      if (!minioClient) return res.status(500).json({ success: false, err: "minioClient not initialized" });

      // 필수 params
      const divisionIdx = (req.body.divisionIdx || "").toString();
      const trainingProductIdx = (req.body.trainingProductIdx || "").toString();
      const productIdx = (req.body.productIdx || "").toString();

      if (!divisionIdx || !trainingProductIdx || !productIdx) {
        return res.status(400).json({
          success: false,
          err: "divisionIdx, trainingProductIdx, productIdx are required",
        });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({ success: false, err: "zip file is required (field name: zip)" });
      }

      // 원본 경로
      const originalPrefix = `NewAnnotation/${divisionIdx}_${trainingProductIdx}_${productIdx}`;

      // 새로운 업로드 경로 (검수 완료)
      // /productAnnotation/{trainProductIdx}_{productEngName}_{날짜시간} 형식
      let uploadPrefix = req.body.uploadPrefix;
      if (!uploadPrefix) {
        const trainProductIdx = (req.body.trainProductIdx || trainingProductIdx).toString();
        const productEngName = (req.body.productEngName || "unknown").toString();
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const dateTimeStr = `${date}_${time}`;

        uploadPrefix = `productAnnotation/${trainProductIdx}_${productEngName}_${dateTimeStr}`;
      }

      // Zip 파일 풀어서 업로드
      const directory = await unzipper.Open.buffer(req.file.buffer);

      const normalizeRel = (p) =>
        String(p || "")
          .replace(/\\/g, "/")
          .replace(/^\/*/, "")
          .replace(/\.\./g, "_");

      let uploadedCount = 0;

      for (const entry of directory.files) {
        if (entry.type !== "File") continue;

        const rel = normalizeRel(entry.path);
        if (!rel) continue;

        const key = `${uploadPrefix}/${rel}`;
        const contentType = mime.lookup(rel) || "application/octet-stream";

        await new Promise((resolve, reject) => {
          minioClient.putObject(
            BUCKET,
            key,
            entry.stream(),
            { "Content-Type": contentType },
            (e, etag) => {
              if (e) return reject(e);
              uploadedCount += 1;
              resolve(etag);
            }
          );
        });
      }

      // 원본 폴더 삭제 (originalPrefix 아래 모든 파일)
      let deletedCount = 0;
      const deleteStream = minioClient.listObjectsV2(BUCKET, originalPrefix, true);

      const filesToDelete = [];
      deleteStream.on("data", (obj) => {
        if (!obj?.name || obj.name.endsWith("/")) return;
        filesToDelete.push(obj.name);
      });

      deleteStream.on("error", async (err) => {
        // 삭제 실패해도 업로드는 성공했으므로 경고만 함
        console.error("[ANNOTATION DELETE ERROR]", String(err));
      });

      deleteStream.on("end", async () => {
        // 파일 삭제 (병렬 처리)
        if (filesToDelete.length > 0) {
          await Promise.all(
            filesToDelete.map(
              (key) =>
                new Promise((resolve) => {
                  minioClient.removeObject(BUCKET, key, (err) => {
                    if (!err) deletedCount += 1;
                    resolve();
                  });
                })
            )
          );
        }

        return res.json({
          success: true,
          bucket: BUCKET,
          uploadPrefix,
          uploadedCount,
          originalPrefix,
          deletedCount,
          message: `Uploaded ${uploadedCount} files and deleted ${deletedCount} original files`,
        });
      });
    } catch (e) {
      return res.status(500).json({ success: false, err: e?.message || String(e) });
    }
  });
});

// List objects under a given prefix (useful to verify uploaded files)
// query: prefix=productAnnotation/xxx
router.get('/annotation/list-prefix', async (req, res) => {
  try {
    const minioClient = req.app.locals.minioClient;
    const BUCKET = req.app.locals.minioBucket || 'chaiimage';
    if (!minioClient) return res.status(500).json({ success: false, err: 'minioClient not initialized' });

    const prefix = (req.query.prefix || '').toString();
    if (!prefix) return res.status(400).json({ success: false, err: 'prefix is required' });

    const items = [];
    const stream = minioClient.listObjectsV2(BUCKET, prefix, true);
    stream.on('data', (obj) => {
      if (!obj?.name) return;
      if (obj.name.endsWith('/')) return;
      items.push({ key: obj.name, size: obj.size, etag: obj.etag });
    });
    stream.on('error', (err) => {
      return res.status(500).json({ success: false, err: String(err) });
    });
    stream.on('end', () => {
      return res.json({ success: true, bucket: BUCKET, prefix, count: items.length, items: items.slice(0, 100) });
    });
  } catch (e) {
    return res.status(500).json({ success: false, err: e?.message || String(e) });
  }
});


module.exports = router;
