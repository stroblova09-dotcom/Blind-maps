import { memo } from 'react'
import { MapPin, Pencil, Trash2 } from 'lucide-react'
import type { Feature } from './projectModel'

type ProjectPlaceRowProps = {
  feature: Feature
  index: number
  selected: boolean
  onSelect: (id: string) => void
  onEdit: (feature: Feature) => void
  onRemove: (id: string) => void
}

function ProjectPlaceRowComponent({ feature, index, selected, onSelect, onEdit, onRemove }: ProjectPlaceRowProps) {
  return <div className={`place-row ${selected ? 'selected-row' : ''}`} onClick={() => onSelect(feature.id)}>
    <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
    <span className="place-pin"><MapPin size={14} /></span>
    <div className="place-copy"><strong>{feature.name}</strong><span>{feature.type || 'bez typu'} · {feature.lat.toFixed(2)}°, {feature.lng.toFixed(2)}°{feature.geometry ? ' · geometrie' : ''}</span></div>
    <button className="edit-button" aria-label={`Upravit ${feature.name}`} onClick={(event) => { event.stopPropagation(); onEdit(feature) }}><Pencil size={14} /></button>
    <button className="delete-button" aria-label={`Odstranit ${feature.name}`} onClick={(event) => { event.stopPropagation(); onRemove(feature.id) }}><Trash2 size={15} /></button>
  </div>
}

export const ProjectPlaceRow = memo(ProjectPlaceRowComponent)