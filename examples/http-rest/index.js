'use script'

module.exports.get = (event, context, cb) => {
  console.log(event)
  cb(null, { body: `GET resource with id: ${event.data.params.id}` })
}

module.exports.post = (event, context, cb) => {
  console.log(event)
  cb(null, { body: `POST resource with id: ${event.data.params.id}` })
}

module.exports.delete = (event, context, cb) => {
  console.log(event)
  cb(null, { body: `DELETE resource with id: ${event.data.params.id}` })
}
