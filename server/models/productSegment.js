const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const productSegmentSchema = mongoose.Schema({
    //mongoDB 고유 id값
    segmentIdx: mongoose.Schema.Types.ObjectId,
    //PNT에 등록된 상품 고유번호 (FK)
    productIdx: {
        type: String,
    },
    //PNT에 등록된 상품 이름(영어)
    productEngName: {
        type: String
    },
    //스냅샷 세그먼트 파일명(productIdx_날짜시간.pkl)
    segFileName: {
        type: String
    },
    //스냅샷 세그먼트 파일경로(chaiimg/productSegment/)
    segFilePath: {
        type: String
    },
    //날짜
    createdAt: {
        type: Date,
        default: Date.now
    }
})

const ProductSegment = mongoose.model('ProductSegment', productSegmentSchema, 'ProductsSegment');


module.exports = { ProductSegment }