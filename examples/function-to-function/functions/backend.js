"use script";

module.exports.backend = (event, context, cb) => {
  cb(null, {message: "hello from backend"});
};
