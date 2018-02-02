"use script";

module.exports.handler = (event, context, cb) => {
  console.log(event);

  cb(null, { message: "success" });
};
