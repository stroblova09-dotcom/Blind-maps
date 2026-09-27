import type { Feature, Project } from './projectModel'

export type QuizItemStatus = 'answered' | 'active' | 'correct' | 'wrong' | 'upcoming'
export type QuizFeedback = 'idle' | 'correct' | 'wrong' | 'far'
export type QuizChecklistItem = { id: string; name: string; order: number; status: QuizItemStatus }
export type QuizContextState = { projectId: string; testIndex: number; feedback: QuizFeedback; target: Feature | undefined; items: QuizChecklistItem[] }

export const getQuizContext = (project: Project, testIndex: number, feedback: QuizFeedback): QuizContextState => {
  const targetId = project.testOrder[testIndex]
  const target = project.features.find((feature) => feature.id === targetId)
  const featureNames = new Map(project.features.map((feature) => [feature.id, feature.name]))
  const items = project.testOrder.flatMap((id, order) => {
    const name = featureNames.get(id)
    if (name === undefined) return []
    let status: QuizItemStatus = 'upcoming'
    if (order < testIndex) status = 'answered'
    else if (order === testIndex) status = feedback === 'correct' || feedback === 'wrong' ? feedback : 'active'
    return [{ id, name, order, status }]
  })
  return { projectId: project.id, testIndex, feedback, target, items }
}