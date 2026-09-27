import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from './projectModel'
import { FullscreenTestContext } from './FullscreenTestContext'
import { getQuizContext } from './testProgress'

const testProject: Project = {
  id: 'quiz-project',
  name: 'Europe',
  continent: 'europe',
  mapLayer: 'blind',
  displayMode: 'shape',
  testOrder: ['first', 'current', 'last'],
  testIndex: 1,
  stats: { answered: 1, correct: 1, wrong: 0 },
  features: [
    { id: 'first', name: 'Dunaj', type: 'řeka', lat: 48, lng: 16 },
    { id: 'current', name: 'Labe', type: 'řeka', lat: 50, lng: 14 },
    { id: 'last', name: 'Rýn', type: 'řeka', lat: 51, lng: 7 },
  ],
}

describe('fullscreen test context', () => {
  it('receives the same test order, current target, feedback, and answered statuses as the map test', () => {
    const context = getQuizContext(testProject, testProject.testIndex, 'correct')
    const markup = renderToStaticMarkup(<FullscreenTestContext context={context} onClose={() => undefined} />)

    expect(context.target?.id).toBe('current')
    expect(context.items.map(({ name, status }) => [name, status])).toEqual([
      ['Dunaj', 'answered'],
      ['Labe', 'correct'],
      ['Rýn', 'upcoming'],
    ])
    expect(markup).toContain('Dunaj')
    expect(markup).toContain('Labe')
    expect(markup).toContain('Rýn')
    expect(markup).toContain('Najdi: Labe')
    expect(testProject.testIndex).toBe(1)
    expect(testProject.testOrder).toEqual(['first', 'current', 'last'])
  })

  it('retains the same in-progress target and feedback when fullscreen is closed/reopened', () => {
    const beforeFullscreen = getQuizContext(testProject, testProject.testIndex, 'wrong')
    const closeFullscreen = () => undefined
    closeFullscreen()
    const afterFullscreen = getQuizContext(testProject, testProject.testIndex, 'wrong')

    expect(afterFullscreen).toEqual(beforeFullscreen)
    expect(afterFullscreen.target?.name).toBe('Labe')
    expect(afterFullscreen.items[1].status).toBe('wrong')
  })
})