import { memo } from 'react'
import type { QuizContextState } from './testProgress'

type FullscreenTestContextProps = {
  context: QuizContextState
  onClose: () => void
}

function FullscreenTestContextComponent({ context, onClose }: FullscreenTestContextProps) {
  const { items, testIndex, target } = context
  return <aside className="fullscreen-test-context" aria-label="Seznam pojmů v aktuálním testu">
    <header><div><span className="section-label">TEST · {Math.min(testIndex + 1, items.length)} / {items.length}</span><strong>{target ? `Najdi: ${target.name}` : 'Test dokončen'}</strong></div><button type="button" aria-label="Zavřít fullscreen mapu" onClick={onClose}>×</button></header>
    <ol>{items.map((item) => <li key={`${item.id}-${item.order}`} className={`quiz-item-${item.status}`} aria-current={item.status === 'active' ? 'step' : undefined}><span className="quiz-item-status" aria-hidden="true">{item.status === 'answered' || item.status === 'correct' ? '✓' : item.status === 'wrong' ? '×' : item.status === 'active' ? '›' : '·'}</span><span>{item.name}</span></li>)}</ol>
    <small>Odpovídej kliknutím na objekt na mapě. Po zavření zůstane test pokračovat.</small>
  </aside>
}

export const FullscreenTestContext = memo(FullscreenTestContextComponent)