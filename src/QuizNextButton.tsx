import { memo } from 'react'
import type { QuizContextState } from './testProgress'

type QuizNextButtonProps = { context: QuizContextState; onNext: () => void; className?: string }

function QuizNextButtonComponent({ context, onNext, className = 'next-button' }: QuizNextButtonProps) {
  if (context.feedback !== 'correct' && context.feedback !== 'wrong') return null
  return <button type="button" onClick={onNext} className={className}>{context.testIndex + 1 >= context.items.length ? 'Zobrazit shrnutí' : 'Další otázka'} <span>→</span></button>
}

export const QuizNextButton = memo(QuizNextButtonComponent)