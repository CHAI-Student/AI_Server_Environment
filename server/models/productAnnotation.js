const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const productAnnotationSchema = mongoose.Schema({
    //mongoDB 고유 id값
    annotationIdx: mongoose.Schema.Types.ObjectId,
    //PNT에 등록된 상품 고유번호 (FK)
    productIdx: {
        type: String,
    },
    //PNT에 등록된 상품 이름(영어)
    productEngName: {
        type: String
    },
    //스냅샷 어노테이션 파일명(productImg_P17355176364813008_20251106_141029_cam_0_frame_000001.txt)
    annoFileName: {
        type: String
    },
    //스냅샷 어노테이션 파일경로(chaiimg/productAnnotation/cam_0/)
    annoFilePath: {
        type: String
    },
    //날짜
    createdAt: {
        type: Date,
        default: Date.now
    }
})

const ProductAnnotation = mongoose.model('ProductAnnotation', productAnnotationSchema, 'ProductsAnnotation');


module.exports = { ProductAnnotation }