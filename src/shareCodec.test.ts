import { describe, expect, it } from 'vitest'
import { compressToBase64 } from 'lz-string'
import type { Position } from 'geojson'
import { decodeSharedProject, encodeSharedProject, SHARE_URL_LIMIT, sharedPayloadUrlLength, type ShareProject } from './shareCodec'

const largeBaikalRing = (): Position[] => {
  const points: Position[] = []
  for (let index = 0; index < 112_049; index++) {
    const angle = (index / 112_048) * Math.PI * 2
    const shorelineDetailX = Math.sin(angle * 113) * 0.002
    const shorelineDetailY = Math.cos(angle * 97) * 0.002
    points.push([
      108 + Math.cos(angle) * 1.3 + shorelineDetailX,
      53 + Math.sin(angle) * 5 + shorelineDetailY,
    ])
  }
  points[points.length - 1] = points[0]
  return points
}

const fixtureProject = (): ShareProject => ({
  id: 'source-project-id',
  name: 'Zeměpis – řeky a jezera 😀',
  continent: 'world',
  mapLayer: 'blind',
  displayMode: 'shape',
  testOrder: ['source-project-id'],
  testIndex: 0,
  stats: { answered: 7, correct: 5, wrong: 2 },
  features: [
    { id: 'prague', name: 'Praha', type: 'město', lat: 50.0755, lng: 14.4378 },
    {
      id: 'amazon', name: 'Amazonka', type: 'řeka', lat: -3.1, lng: -60,
      geometry: {
        type: 'MultiLineString',
        coordinates: [Array.from({ length: 1_848 }, (_, index) => [
          -73 + (index / 1_847) * 23,
          -4 + Math.sin(index / 35) * 2,
        ] as Position)],
      },
    },
    {
      id: 'baikal', name: 'Jezero Bajkal', type: 'jezero', lat: 53.5, lng: 108,
      geometry: { type: 'Polygon', coordinates: [largeBaikalRing()] },
    },
    {
      id: 'himalaya', name: 'Himálaj', type: 'pohoří', lat: 28, lng: 86,
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[80, 27], [85, 28], [90, 29], [88, 31], [82, 30], [80, 27]]],
          [[[91, 27], [94, 28], [96, 29], [95, 31], [92, 30], [91, 27]]],
        ],
      },
    },
  ],
})

describe('share codec', () => {
  it('shares four real-world features with high-detail geometries within the URL budget', () => {
    const project = fixtureProject()
    const token = encodeSharedProject(project)
    const urlLength = sharedPayloadUrlLength(project, 'https://blind-maps1.vercel.app/')

    expect(project.features).toHaveLength(4)
    expect(project.features.filter((feature) => feature.geometry)).toHaveLength(3)
    expect(project.features.find((feature) => feature.id === 'baikal')?.geometry?.type).toBe('Polygon')
    expect(urlLength).toBeLessThanOrEqual(SHARE_URL_LIMIT)
    expect(token.length).toBeLessThan(SHARE_URL_LIMIT)

    const restored = decodeSharedProject(token)
    expect(restored.features).toHaveLength(4)
    expect(restored.features.find((feature) => feature.name === 'Jezero Bajkal')?.geometry?.type).toBe('Polygon')
  })

  it('preserves Czech text and emoji and omits nonessential state/metadata', () => {
    const project = fixtureProject()
    const restored = decodeSharedProject(encodeSharedProject(project))

    expect(restored.name).toBe('Zeměpis – řeky a jezera 😀')
    expect(restored.features.map((feature) => feature.name)).toContain('Amazonka')
    expect(restored.features[0].id).not.toBe('prague')
    expect(restored.features[0]).not.toHaveProperty('displayName')
    expect(restored.testOrder).toEqual([])
    expect(restored.testIndex).toBe(0)
    expect(restored.stats).toEqual({ answered: 0, correct: 0, wrong: 0 })
  })

  it('continues to decode existing lz1 and original btoa share links', () => {
    const project = fixtureProject()
    const json = JSON.stringify(project)
    const compressed = btoa(compressToBase64(json)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const oldLzLink = decodeSharedProject(`lz1_${compressed}`)
    const oldBase64Link = btoa(encodeURIComponent(json))
    const oldOriginalLink = decodeSharedProject(oldBase64Link)

    expect(oldLzLink.features).toHaveLength(4)
    expect(oldOriginalLink.name).toBe(project.name)
    expect(oldOriginalLink.features[2].geometry?.type).toBe('Polygon')
  })
})
