if (process.env.NODE_ENV === 'production') { // 현재 실행 프로세스에 주입된 환경변수들 중 NODE_ENV라는 이름의 환경변수 값을 읽음.
    module.exports = require('./prod'); // prod.js에서 객체를 읽어옴
} else {
    module.exports = require('./dev'); // dev.js에서 객체를 읽어옴
}