const express = require("express");
const router = express.Router();
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const Minio = require("minio");
const config = require("../../config/key");

//=================================
//        Product Upload
//=================================

// multer: 메모리로 받아서 MinIO로 바로 업로드
// const upload = multer({ storage: multer.memoryStorage() }).array("files", 2000);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2000,                 // 상한선
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


module.exports = router;
