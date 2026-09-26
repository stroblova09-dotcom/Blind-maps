import type { Feature, Project } from './projectModel'

export type FeaturePresentationInput = {
  feature: Feature
  displayMode: Project['displayMode']
  mode: 'edit' | 'test'
  feedback: 'idle' | 'correct' | 'wrong' | 'far'
  targetId: string | undefined
  selectedId: string | null
  hovered: boolean
}

export const getFeaturePresentation = ({ feature, displayMode, mode, feedback, targetId, selectedId, hovered }: FeaturePresentationInput) => {
  const showShape = displayMode === 'shape' && Boolean(feature.geometry && feature.geometry.type !== 'Point')
  const isTarget = mode === 'test' && feature.id === targetId
  const isSelected = feature.id === selectedId
  const neutral = mode === 'test' && feedback === 'idle'
  const revealed = mode === 'test' && (feedback === 'correct' || feedback === 'wrong') && (isTarget || isSelected)
  const color = neutral ? '#174b43' : isTarget ? '#3d8c70' : isSelected ? '#d85b45' : '#174b43'

  return {
    showShape,
    isTarget,
    isSelected,
    neutral,
    revealed,
    hovered,
    color,
    pathColor: neutral ? (hovered ? '#438b91' : '#75b7c1') : (hovered ? '#ed6a3a' : color),
    fillColor: neutral ? '#a9d6d9' : color,
    pointRadius: (revealed ? 9 : 7) + (hovered ? 2 : 0),
    showTooltip: mode === 'edit' || (mode === 'test' && (feedback === 'correct' || feedback === 'wrong') && (feature.id === targetId || feature.id === selectedId)),
    permanentTooltip: mode === 'test' && revealed,
  }
}