import { describe, expect, it } from 'vitest'
import type { Feature } from './projectModel'
import { getFeaturePresentation } from './featurePresentation'

const feature: Feature = {
  id: 'river',
  name: 'Řeka',
  type: 'řeka',
  lat: 50,
  lng: 14,
  geometry: { type: 'LineString', coordinates: [[14, 50], [15, 51]] },
}

const presentation = (overrides: Partial<Parameters<typeof getFeaturePresentation>[0]> = {}) => getFeaturePresentation({
  feature,
  displayMode: 'shape',
  mode: 'edit',
  feedback: 'idle',
  targetId: undefined,
  selectedId: null,
  hovered: false,
  ...overrides,
})

describe('map feature presentation', () => {
  it('preserves shape/dot display and edit-mode name tooltips', () => {
    expect(presentation().showShape).toBe(true)
    expect(presentation().showTooltip).toBe(true)
    expect(presentation({ displayMode: 'points' })).toMatchObject({ showShape: false, showTooltip: true })
  })

  it('preserves hover feedback for shapes and dots without revealing test names', () => {
    expect(presentation({ mode: 'test', feedback: 'idle', targetId: 'river', hovered: true })).toMatchObject({
      showShape: true,
      showTooltip: false,
      pathColor: '#438b91',
    })
    expect(presentation({ displayMode: 'points', mode: 'test', feedback: 'idle', targetId: 'river', hovered: true })).toMatchObject({
      showShape: false,
      showTooltip: false,
      pointRadius: 9,
    })
  })

  it('preserves revealed target name and permanent tooltip after an answer', () => {
    expect(presentation({ mode: 'test', feedback: 'correct', targetId: 'river' })).toMatchObject({
      isTarget: true,
      revealed: true,
      showTooltip: true,
      permanentTooltip: true,
      pointRadius: 9,
    })
  })
})