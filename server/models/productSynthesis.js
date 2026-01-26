const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const productSynthesisSchema = mongoose.Schema({
    //mongoDB 고유 id값
    synthesisIdx: mongoose.Schema.Types.ObjectId,
    //PNT에 등록된 상품 고유번호 (FK)
    productIdx: {
        type: String,
    },
    //PNT에 등록된 상품 이름(영어)
    productEngName: {
        type: String
    },
    //매장 고유번호 (FK)
    divisionIdx: {
        type: String
    },
    //매장별 학습 세그먼트 파일명(divisionIdx_productIdx_syn000001.jpg)
    synImgFileName: {
        type: String
    },
    //매장별 학습 세그먼트 파일명(divisionIdx_productIdx_syn000001.txt)
    synTxtFileName: {
        type: String
    },
    //매장별 학습 세그먼트 파일경로(chaiimg/divisionSynthesis/divisionIdx_productIdx)
    synFilePath: {
        type: String
    },
    //날짜
    createdAt: {
        type: Date,
        default: Date.now
    }
})

const ProductSynthesis = mongoose.model('ProductSynthesis', productSynthesisSchema, 'ProductsSynthesis');


module.exports = { ProductSynthesis }