import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from './projectModel'
import { FullscreenTestContext } from './FullscreenTestContext'
import { QuizNextButton } from './QuizNextButton'
import { advanceQuizState, getQuizContext } from './testProgress'

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
    const markup = renderToStaticMarkup(<FullscreenTestContext context={context} onClose={() => undefined} onNext={() => undefined} />)

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

  it.each([
    { index: 0, answer: 'correct' as const, nextIndex: 1 },
    { index: 1, answer: 'wrong' as const, nextIndex: 2 },
    { index: 2, answer: 'correct' as const, nextIndex: 3 },
  ])('Next after a $answer answer advances shared state from index $index to $nextIndex', ({ index, answer, nextIndex }) => {
    const currentProject = { ...testProject, testIndex: index }
    const currentContext = getQuizContext(currentProject, currentProject.testIndex, answer)
    const nextProject = advanceQuizState(currentProject)
    const nextContext = getQuizContext(nextProject, nextProject.testIndex, 'idle')

    expect(currentContext.feedback).toBe(answer)
    expect(nextProject.testOrder).toBe(currentProject.testOrder)
    expect(nextContext.testIndex).toBe(nextIndex)
    expect(nextContext.target?.id).toBe(nextIndex < currentProject.testOrder.length ? currentProject.testOrder[nextIndex] : undefined)
  })

  it('uses the same Next button state and shared callback in fullscreen and normal test controls', () => {
    const context = getQuizContext(testProject, 1, 'wrong')
    const markup = renderToStaticMarkup(<QuizNextButton context={context} onNext={() => undefined} />)
    const hiddenMarkup = renderToStaticMarkup(<QuizNextButton context={getQuizContext(testProject, 1, 'idle')} onNext={() => undefined} />)
    expect(markup).toContain('Další otázka')
    expect(hiddenMarkup).toBe('')
  })

  it('exposes the completion transition after Next on the last question', () => {
    const lastProject = { ...testProject, testIndex: 2 }
    const context = getQuizContext(lastProject, lastProject.testIndex, 'correct')
    const markup = renderToStaticMarkup(<QuizNextButton context={context} onNext={() => undefined} />)
    expect(markup).toContain('Zobrazit shrnutí')
    expect(advanceQuizState(lastProject).testIndex).toBe(lastProject.testOrder.length)
  })
})