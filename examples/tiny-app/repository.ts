import { database } from './database'
import { worker } from './worker'

export const repository = {
  async find(id: string) {
    const record = await database.read(id)
    if (record) await worker.publish({ type: 'record.read', id })
    return record
  },
}
