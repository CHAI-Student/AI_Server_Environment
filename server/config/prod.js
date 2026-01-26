module.exports = {
    mongoURI:process.env.MONGO_URI,

    restApi: process.env.REST_API,
    userId: process.env.USER_ID,
    userPassword: process.env.USER_PASSWORD,
    jwtToken: process.env.JWT_TOKEN,
    jwtTokenAt: process.env.JWT_TOKEN_AT,
    
    minioAccessKey: process.env.MINIO_ACCESS_KEY,
    minioSecretKey: process.env.MINIO_SECRET_KEY,
    minioURL: process.env.MINIO_URL,
    minioBucket: process.env.MINIO_BUCKET,
}