import { describe, expect, it } from 'vitest'
import type { Feature, Project } from './projectModel'
import { projectToFirestore, firestoreToProject, FIRESTORE_CHUNK_BYTES, joinGeometry, measureLocalProjects, migrateLocalProjects, ProjectRepository, ProjectRevisionConflictError, splitGeometry } from './projectRepository'
import type { DocumentMutation, DocumentPath, ProjectRepositoryAdapter } from './projectRepository'

const sampleProject = (id = 'europe-project'): Project => ({
  id,
  name: 'Evropa 🇪🇺',
  continent: 'europe',
  mapLayer: 'blind',
  displayMode: 'shape',
  testOrder: ['river'],
  testIndex: 0,
  stats: { answered: 4, correct: 3, wrong: 1 },
  features: [{ id: 'river', name: 'Řeka', type: 'řeka', lat: 50, lng: 14, displayName: 'Řeka, Evropa' }],
})

const largeGeometry = (): Feature['geometry'] => {
  const coordinates: number[][] = []
  for (let index = 0; index < 112_049; index++) {
    const angle = index / 112_048 * Math.PI * 2
    coordinates.push([108 + Math.cos(angle) * 1.3 + Math.sin(angle * 113) * 0.002, 53 + Math.sin(angle) * 5 + Math.cos(angle * 97) * 0.002])
  }
  coordinates[coordinates.length - 1] = coordinates[0]
  return { type: 'Polygon', coordinates: [coordinates] }
}

class MemoryAdapter implements ProjectRepositoryAdapter {
  readonly projects = new Map<string, Record<string, unknown>>()
  readonly features = new Map<string, Record<string, unknown>>()
  readonly chunks = new Map<string, Record<string, unknown>>()
  shouldFail = false
  listener: (() => void) | null = null

  private key(uid: string, path: DocumentPath) {
    if (path.collection === 'projects') return `${uid}/projects/${path.projectId}`
    if (path.collection === 'features') return `${uid}/projects/${path.projectId}/features/${path.featureId}`
    return `${uid}/projects/${path.projectId}/features/${path.featureId}/geometryChunks/${path.chunkId}`
  }

  async getProject(uid: string, projectId: string) { return this.projects.get(`${uid}/projects/${projectId}`) ?? null }
  async listProjects(uid: string) {
    return [...this.projects.entries()].filter(([key]) => key.startsWith(`${uid}/projects/`)).map(([key, data]) => ({ id: key.split('/')[2], data }))
  }
  async listFeatures(uid: string, projectId: string) {
    const prefix = `${uid}/projects/${projectId}/features/`
    return [...this.features.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, data]) => ({ id: key.slice(prefix.length), data }))
  }
  async listGeometryChunks(uid: string, projectId: string, featureId: string) {
    const prefix = `${uid}/projects/${projectId}/features/${featureId}/geometryChunks/`
    return [...this.chunks.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, data]) => ({ id: key.slice(prefix.length), data }))
  }
  async commit(uid: string, mutations: DocumentMutation[]) {
    if (this.shouldFail) throw new Error('simulated write failure')
    for (const mutation of mutations) {
      const collection = mutation.path.collection === 'projects' ? this.projects : mutation.path.collection === 'features' ? this.features : this.chunks
      const key = this.key(uid, mutation.path)
      if (mutation.data) collection.set(key, structuredClone(mutation.data))
      else collection.delete(key)
    }
    this.listener?.()
  }
  watchProjects(_uid: string, onChange: () => void) { this.listener = onChange; return () => { this.listener = null } }
}

const memoryStorage = () => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

describe('project Firestore repository', () => {
  it('converts Project metadata to Firestore and back without changing the Project shape', () => {
    const project = sampleProject()
    const metadata = projectToFirestore(project, 3, 10, 20)
    const restored = firestoreToProject(metadata as unknown as Record<string, unknown>, project.features)

    expect(metadata).toMatchObject({ schemaVersion: 1, revision: 3, createdAt: 10, updatedAt: 20, featureCount: 1 })
    expect(restored.project).toEqual(project)
    expect(restored).toMatchObject({ revision: 3, createdAt: 10, updatedAt: 20 })
    expect(restored.project).not.toHaveProperty('revision')
  })

  it('preserves a real 112,049-position geometry exactly across safe chunks', () => {
    const geometry = largeGeometry()
    const serializedBytes = new TextEncoder().encode(JSON.stringify(geometry)).length
    const encoded = splitGeometry(geometry)
    const restored = joinGeometry(encoded.chunks, encoded.byteLength)

    expect(serializedBytes).toBeGreaterThan(4_000_000)
    expect(encoded.chunks.length).toBeGreaterThan(1)
    expect(encoded.byteLength).toBe(serializedBytes)
    expect(encoded.chunks.every((chunk) => new TextEncoder().encode(chunk).length < 180_000)).toBe(true)
    expect(FIRESTORE_CHUNK_BYTES).toBe(128 * 1024)
    expect(restored).toEqual(geometry)
  })

  it('measures the exact local payload and geometry byte sizes before migration', () => {
    const project = sampleProject()
    project.features[0].geometry = { type: 'LineString', coordinates: [[14, 50], [15, 51]] }
    const raw = JSON.stringify({ version: 2, projects: [project] })
    const measurement = measureLocalProjects(raw, [project])

    expect(measurement.localStoreBytes).toBe(new TextEncoder().encode(raw).length)
    expect(measurement.geometryBytes).toBe(new TextEncoder().encode(JSON.stringify(project.features[0].geometry)).length)
    expect(measurement.largestGeometryBytes).toBe(measurement.geometryBytes)
    expect(measurement).toMatchObject({ projectCount: 1, featureCount: 1 })
  })

  it('creates, updates with revision checks, and deletes a project and its geometry documents', async () => {
    const adapter = new MemoryAdapter()
    const repository = new ProjectRepository(adapter, () => 100)
    const initial = sampleProject()
    initial.features[0].geometry = { type: 'LineString', coordinates: [[14, 50], [15, 51]] }
    const created = await repository.saveProject('uid-1', initial, 0)
    expect(created.revision).toBe(1)
    expect((await repository.listProjects('uid-1'))[0].project).toEqual(initial)

    const changed = { ...initial, name: 'Střední Evropa' }
    const updated = await repository.saveProject('uid-1', changed, created.revision)
    expect(updated.revision).toBe(2)
    expect((await repository.listProjects('uid-1'))[0].project.name).toBe('Střední Evropa')
    await expect(repository.saveProject('uid-1', initial, created.revision)).rejects.toBeInstanceOf(ProjectRevisionConflictError)

    await repository.deleteProject('uid-1', initial.id)
    expect(await repository.listProjects('uid-1')).toEqual([])
    expect(adapter.features.size).toBe(0)
    expect(adapter.chunks.size).toBe(0)
  })

  it('backs up and migrates local projects, skipping cloud ID collisions without overwriting', async () => {
    const adapter = new MemoryAdapter()
    const repository = new ProjectRepository(adapter, () => 200)
    await repository.saveProject('uid-1', { ...sampleProject(), name: 'Cloud verze' }, 0)
    const local = { version: 2, activeProjectId: 'europe-project', projects: [{ ...sampleProject(), name: 'Lokální verze' }, sampleProject('asia-project')] }
    const raw = JSON.stringify(local)
    const storage = memoryStorage()
    storage.setItem('atlas-memo-projects-v2', raw)

    const result = await migrateLocalProjects(repository, 'uid-1', storage, raw)
    const restored = await repository.listProjects('uid-1')

    expect(storage.getItem('atlas-memo-projects-v2')).toBe(raw)
    expect(storage.getItem(result.backupKey)).toBe(raw)
    expect(result.skippedCount).toBe(1)
    expect(restored.find(({ project }) => project.id === 'europe-project')?.project.name).toBe('Cloud verze')
    expect(restored.map(({ project }) => project.id)).toContain('asia-project')
  })

  it('retains the original localStorage and its backup if any migration write fails', async () => {
    const adapter = new MemoryAdapter()
    const repository = new ProjectRepository(adapter)
    const raw = JSON.stringify({ version: 2, projects: [sampleProject()] })
    const storage = memoryStorage()
    storage.setItem('atlas-memo-projects-v2', raw)
    adapter.shouldFail = true

    await expect(migrateLocalProjects(repository, 'uid-1', storage, raw)).rejects.toThrow('simulated write failure')
    expect(storage.getItem('atlas-memo-projects-v2')).toBe(raw)
    expect([...storage.data.keys()].some((key) => key.startsWith('atlas-memo-projects-v2.backup.'))).toBe(true)
  })
})