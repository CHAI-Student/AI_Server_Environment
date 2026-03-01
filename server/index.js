const express = require("express");
const app = express();
const path = require("path");
const fs = require("fs"); // used in routes and helpers
const cors = require('cors')
const axios = require('axios');

const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

require("dotenv").config();

const config = require("./config/key");

//mongoDB 연결
const mongoose = require("mongoose");
mongoose
  .connect(config.mongoURI)
  .then(() => console.log("[MONGO-DB] DB connected"))
  .catch(err => console.error(err));

//MinIO 연결
const Minio = require("minio");

const minioClient = new Minio.Client({
  endPoint: config.minioURL,
  port: 9000,
  useSSL: false,
  accessKey: config.minioAccessKey,
  secretKey: config.minioSecretKey,
});

app.locals.minioClient = minioClient;
app.locals.minioBucket = "chaiimage"; // 또는 config로

(async () => {
  try {
    const buckets = await minioClient.listBuckets();
    console.log("[MINIO] Buckets:", buckets);
  } catch (err) {
    console.error("[MINIO] error:", err);
  }
})();

app.use(cors())
app.use(express.json());

//to not get any deprecation warning or error
//support parsing of application/x-www-form-urlencoded post data
app.use(bodyParser.urlencoded({ extended: true }));
//to get json data
// support parsing of application/json type post data
app.use(bodyParser.json());
app.use(cookieParser());

// console.log(process.env.NODE_ENV)
app.use(function (req, res, next) {
  // console.log(req);
  return next();
})

//use this to show the image you have in node js server to client (react js)
//https://stackoverflow.com/questions/48914987/send-image-path-from-node-js-express-server-to-react-client

const productRouter = require("./routes/products"); // 상품 및 어노테이션 라우터
app.use("/api", productRouter);

app.use('/products', express.static('uploads'));
app.use('/uploads/images', express.static('images'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Serve static assets if in production
if (process.env.NODE_ENV === "production") {

  // Set static folder   
  // All the javascript and css files will be read and served from this folder
  app.use(express.static("client/build"));

  // index.html for all page routes    html or routing and naviagtion
  app.get("*", (req, res) => {
    res.sendFile(path.resolve(__dirname, "../client", "build", "index.html"));
  });
}

const port = process.env.PORT || 9000;

// start server with error handling to avoid crashing on EADDRINUSE
const server = app.listen(port, () => {
  console.log(`Server Listening on ${port}`);
  // 서버 시작 시 GPU 서버 헬스 체크 한 번 실행
  checkGpuHealth();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Another instance may be running.`);
    process.exit(1);
  } else {
    console.error('Server error', err);
  }
});

// GPU 서버 상태 확인 helper
async function checkGpuHealth() {
  const url = 'http://139.150.8.82:2140/health';
  try {
    const resp = await axios.get(url, { timeout: 3000 });
    console.log(`[GPU-HEALTH] OK - ${url} ->`, resp.data);
    return resp.data;
  } catch (err) {
    console.error(`[GPU-HEALTH] FAIL - ${url} ->`, err.message || err);
    return null;
  }
}

// 간단한 프록시 엔드포인트 (로컬에서 GPU 헬스 체크 확인용)
app.get('/gpu-health', async (req, res) => {
  const data = await checkGpuHealth();
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(502).json({ success: false, err: 'gpu health check failed' });
  }
});
console.log(`Server Listening on ${port}`);
// 서버 시작 시 GPU 서버 헬스 체크 한 번 실행
checkGpuHealth();
// 이후에는 주기적으로 확인하고 싶다면 아래처럼 설정
// setInterval(checkGpuHealth, 1000 * 60 * 5); // 5분마다
