import { createDb, claimRun } from '../../dist/index.js'
process.once('message', async ({ env, worker }) => {
  const db = createDb(env)
  try {
    const grants = []
    let emptyStreak = 0
    for (let i = 0; i < 40; i++) {
      const grant = await claimRun(db, { ...worker, leaseTtlSeconds: 60 })
      if (!grant) {
        emptyStreak += 1
        if (emptyStreak >= 3) break
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      emptyStreak = 0
      grants.push(grant)
    }
    process.send({ grants })
  } catch (error) { process.send({ error: error.message }) }
  finally { await db.close(); process.disconnect() }
})
