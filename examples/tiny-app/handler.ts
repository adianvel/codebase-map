import { repository } from './repository'

export async function handleRequest(input: { id: string }) {
  const record = await repository.find(input.id)
  return record ? { status: 200, body: record } : { status: 404 }
}
