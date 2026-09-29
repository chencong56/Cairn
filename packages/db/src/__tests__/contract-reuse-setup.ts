import { afterAll, beforeAll } from 'vitest'
import { beginContractFile, releaseReusedContractDatabases } from './contract-reuse.js'

beforeAll(() => {
  beginContractFile()
})

afterAll(async () => {
  await releaseReusedContractDatabases()
})
