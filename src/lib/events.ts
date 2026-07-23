import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { ObjectId } from "mongodb"
import { getDatabase } from "@/lib/mongodb"
import { getCityByName } from "@/lib/cities"
import type { Event } from "@/types"

interface EventDocument {
  _id?: ObjectId
  name: string
  nameLower: string
  cityId: ObjectId
  isActive: boolean
  eventDate?: string
  createdAt: Date
  updatedAt: Date
}

interface FileEventRecord {
  id: string
  name: string
  nameLower: string
  cityId: string
  isActive: boolean
  eventDate?: string
  createdAt: string
  updatedAt: string
}

function resolveStoreDir() {
  const configured = (process.env.LOCAL_STORE_PATH || "").trim()
  if (configured && !(process.platform === "win32" && configured.startsWith("/"))) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured)
  }

  return path.join(process.cwd(), ".data")
}

const dataFilePath = path.join(resolveStoreDir(), "events.json")

function shouldUseMongo() {
  const requireMongo = (process.env.REQUIRE_MONGODB || "").toLowerCase()
  if (requireMongo === "1" || requireMongo === "true" || requireMongo === "yes") {
    if (!process.env.MONGODB_URI) {
      throw new Error("MongoDB is required (set MONGODB_URI).")
    }
    return true
  }

  return Boolean(process.env.MONGODB_URI)
}

function normalizeNameLower(name: string) {
  return name.trim().toLowerCase()
}

async function ensureDataFile() {
  const dataDir = path.dirname(dataFilePath)
  await mkdir(dataDir, { recursive: true })
  try {
    await readFile(dataFilePath, "utf8")
  } catch {
    await writeFile(dataFilePath, "[]", "utf8")
  }
}

async function readFileStore() {
  await ensureDataFile()
  const content = await readFile(dataFilePath, "utf8")
  if (!content.trim()) return [] as FileEventRecord[]
  const parsed = JSON.parse(content) as FileEventRecord[]
  return parsed.filter((item) => item?.id && item?.name && item?.cityId)
}

async function writeFileStore(records: FileEventRecord[]) {
  await ensureDataFile()
  await writeFile(dataFilePath, JSON.stringify(records, null, 2), "utf8")
}

async function getCollection() {
  const db = await getDatabase()
  const collection = db.collection<EventDocument>("events")
  await collection.createIndex({ cityId: 1, nameLower: 1 }, { unique: true })
  await collection.createIndex({ cityId: 1, isActive: 1 })
  await collection.createIndex({ createdAt: -1 })
  return collection
}

function mapMongoEvent(doc: EventDocument): Event {
  return {
    id: doc._id ? doc._id.toString() : `${doc.cityId.toString()}:${doc.nameLower}`,
    name: doc.name,
    cityId: doc.cityId.toString(),
    isActive: doc.isActive,
    eventDate: doc.eventDate,
  }
}

function mapFileEvent(doc: FileEventRecord): Event {
  return {
    id: doc.id,
    name: doc.name,
    cityId: doc.cityId,
    isActive: doc.isActive,
    eventDate: doc.eventDate,
  }
}

export async function listEvents(options?: { cityId?: string; onlyActive?: boolean }): Promise<Event[]> {
  const onlyActive = Boolean(options?.onlyActive)
  const cityId = options?.cityId

  if (shouldUseMongo()) {
    const collection = await getCollection()
    const filter: Record<string, unknown> = {}
    if (cityId) {
      if (!ObjectId.isValid(cityId)) return []
      filter.cityId = new ObjectId(cityId)
    }
    if (onlyActive) {
      filter.isActive = true
    }

    const items = await collection.find(filter).sort({ createdAt: -1 }).toArray()
    return items.map(mapMongoEvent)
  }

  const records = await readFileStore()
  return records
    .filter((item) => {
      if (cityId && item.cityId !== cityId) return false
      if (onlyActive && !item.isActive) return false
      return true
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(mapFileEvent)
}

export async function listActiveEventsByCityName(cityName: string): Promise<Event[]> {
  const city = await getCityByName(cityName)
  if (!city) return []
  return listEvents({ cityId: city.id, onlyActive: true })
}

export async function createEvent(input: { name: string; cityId: string; eventDate?: string }): Promise<Event> {
  const trimmed = input.name.trim()
  if (!trimmed) {
    throw new Error("Event name is required")
  }
  if (!ObjectId.isValid(input.cityId)) {
    throw new Error("Invalid cityId")
  }

  const nameLower = normalizeNameLower(trimmed)

  if (shouldUseMongo()) {
    const collection = await getCollection()
    const now = new Date()
    const cityIdObj = new ObjectId(input.cityId)

    const existing = await collection.findOne({ cityId: cityIdObj, nameLower })
    if (existing) {
      return mapMongoEvent(existing)
    }

    const result = await collection.insertOne({
      name: trimmed,
      nameLower,
      cityId: cityIdObj,
      isActive: true,
      eventDate: input.eventDate,
      createdAt: now,
      updatedAt: now,
    })

    const created = await collection.findOne({ _id: result.insertedId })
    if (!created) {
      throw new Error("Failed to create event")
    }

    return mapMongoEvent(created)
  }

  const records = await readFileStore()
  const existing = records.find((item) => item.cityId === input.cityId && item.nameLower === nameLower)
  if (existing) {
    return mapFileEvent(existing)
  }

  const now = new Date().toISOString()
  const created: FileEventRecord = {
    id: new ObjectId().toString(),
    name: trimmed,
    nameLower,
    cityId: input.cityId,
    isActive: true,
    eventDate: input.eventDate,
    createdAt: now,
    updatedAt: now,
  }

  records.push(created)
  await writeFileStore(records)
  return mapFileEvent(created)
}

export async function setEventActive(id: string, isActive: boolean): Promise<Event> {
  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid event id")
  }

  if (shouldUseMongo()) {
    const collection = await getCollection()
    const now = new Date()

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: { isActive: Boolean(isActive), updatedAt: now } })
    const updated = await collection.findOne({ _id: new ObjectId(id) })
    if (!updated) {
      throw new Error("Event not found")
    }
    return mapMongoEvent(updated)
  }

  const records = await readFileStore()
  const idx = records.findIndex((item) => item.id === id)
  if (idx < 0) {
    throw new Error("Event not found")
  }

  const now = new Date().toISOString()
  const updated: FileEventRecord = { ...records[idx], isActive: Boolean(isActive), updatedAt: now }
  records[idx] = updated
  await writeFileStore(records)
  return mapFileEvent(updated)
}

export async function validateEventSelection(input: { cityName: string; eventName: string }) {
  const cityNameLower = normalizeNameLower(input.cityName)
  const eventNameLower = normalizeNameLower(input.eventName)
  if (!cityNameLower || !eventNameLower) {
    return { ok: false as const, reason: "missing" as const }
  }

  const city = await getCityByName(cityNameLower)
  if (!city) {
    return { ok: false as const, reason: "city_not_found" as const }
  }

  if (shouldUseMongo()) {
    const collection = await getCollection()
    const items = await collection
      .find({
        cityId: new ObjectId(city.id),
        nameLower: eventNameLower,
      })
      .limit(1)
      .toArray()
    const event = items[0]
    if (!event) return { ok: false as const, reason: "event_not_found" as const }
    if (!event.isActive) return { ok: false as const, reason: "inactive" as const }
    return { ok: true as const, event: mapMongoEvent(event) }
  }

  const records = await readFileStore()
  const event = records.find((item) => item.cityId === city.id && item.nameLower === eventNameLower)
  if (!event) return { ok: false as const, reason: "event_not_found" as const }
  if (!event.isActive) return { ok: false as const, reason: "inactive" as const }
  return { ok: true as const, event: mapFileEvent(event) }
}

export async function updateEvent(id: string, input: { name?: string; eventDate?: string }): Promise<Event> {
  const trimmed = input.name ? input.name.trim() : undefined
  if (trimmed === "") {
    throw new Error("Event name is required")
  }
  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid event id")
  }

  const nameLower = trimmed ? normalizeNameLower(trimmed) : undefined

  if (shouldUseMongo()) {
    const collection = await getCollection()
    const now = new Date()

    const currentEvent = await collection.findOne({ _id: new ObjectId(id) })
    if (!currentEvent) {
      throw new Error("Event not found")
    }

    const existing = await collection.findOne({ cityId: currentEvent.cityId, nameLower, _id: { $ne: new ObjectId(id) } })
    if (nameLower && existing) {
      throw new Error("Event with this name already exists in this city")
    }

    const updates: Partial<EventDocument> = { updatedAt: now }
    if (trimmed) updates.name = trimmed
    if (nameLower) updates.nameLower = nameLower
    if (input.eventDate !== undefined) updates.eventDate = input.eventDate

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: updates })

    // update all submissions
    const db = await getDatabase()

    const city = await db
      .collection("cities")
      .findOne({ _id: currentEvent.cityId })

    if (city && input.eventDate !== undefined) {
      await db.collection("submissions").updateMany(
        {
          event: currentEvent.name,
          city: city.name,
        },
        {
          $set: {
            eventAt: new Date(input.eventDate),
            reminderStatus: "pending",
            reminderError: null,
            reminderSentAt: null,
            updatedAt: now,
          },
        }
      )
    }
    
    const updated = await collection.findOne({ _id: new ObjectId(id) })
    if (!updated) {
      throw new Error("Event not found after update")
    }
    return mapMongoEvent(updated)
  }

  const records = await readFileStore()
  const idx = records.findIndex((item) => item.id === id)
  if (idx < 0) {
    throw new Error("Event not found")
  }

  const currentEvent = records[idx]
  const existing = nameLower ? records.find((item) => item.cityId === currentEvent.cityId && item.nameLower === nameLower && item.id !== id) : undefined
  if (existing) {
    throw new Error("Event with this name already exists in this city")
  }

  const now = new Date().toISOString()
  const updated: FileEventRecord = {
    ...currentEvent,
    updatedAt: now,
    ...(trimmed ? { name: trimmed } : {}),
    ...(nameLower ? { nameLower } : {}),
    ...(input.eventDate !== undefined ? { eventDate: input.eventDate } : {})
  }
  records[idx] = updated
  await writeFileStore(records)
  return mapFileEvent(updated)
}

export async function deleteEvent(id: string): Promise<void> {
  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid event id")
  }

  if (shouldUseMongo()) {
    const collection = await getCollection()
    await collection.deleteOne({ _id: new ObjectId(id) })
    return
  }

  const records = await readFileStore()
  const newRecords = records.filter((item) => item.id !== id)
  if (newRecords.length === records.length) {
    throw new Error("Event not found")
  }
  await writeFileStore(newRecords)
}

