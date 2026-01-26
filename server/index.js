const express = require("express");
const app = express();
const path = require("path");
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

// const productRouter = require("../server/routes/AIServer/Products"); // 네 라우터 파일 경로
// app.use("/api", productRouter);

app.use('/products', express.static('uploads'));
app.use('/uploads/images', express.static('images'));

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

app.listen(port, () => {
  console.log(`Server Listening on ${port}`);
});
