'use script'

module.exports.get = (event, context, cb) => {
  console.log(event)
  cb(null, { body: 'GET resource' })
}
