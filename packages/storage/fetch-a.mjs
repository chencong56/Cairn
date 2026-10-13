import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { writeFileSync } from 'node:fs'
const c = new S3Client({
  endpoint: process.env.CAIRN_S3_ENDPOINT, region: process.env.CAIRN_S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: process.env.CAIRN_S3_ACCESS_KEY, secretAccessKey: process.env.CAIRN_S3_SECRET_KEY },
})
const [key, out] = process.argv.slice(2)
const r = await c.send(new GetObjectCommand({ Bucket: process.env.CAIRN_S3_BUCKET, Key: key }))
writeFileSync(out, Buffer.from(await r.Body.transformToByteArray()))
console.log(out)
