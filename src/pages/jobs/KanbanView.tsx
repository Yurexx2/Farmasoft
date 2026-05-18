import { useState } from 'react'
import { api, Candidate } from '../../api/client'
import { T } from '../../i18n'

export type KanbanCol = 'tocontact' | 'contacted' | 'interviewed' | 'accepted' | 'rejected'

/** Derive a candidate's Kanban column from its status / stage / decision. */
export function kanbanColumn(c: Candidate): KanbanCol {
  if (c.status === 'rejected' || c.decision === 'reject') return 'rejected'
  if (c.decision === 'hire') return 'accepted'
  if (c.stage === 'interview' || c.stage === 'decision') return 'interviewed'
  if (c.status === 'contacted') return 'contacted'
  return 'tocontact'
}

const COL_COLOR: Record<KanbanCol, string> = {
  tocontact: '#94A3B8', contacted: '#229ED9', interviewed: '#F59E0B',
  accepted: '#16A34A', rejected: '#DC2626',
}

export function KanbanView({ candidates, t, onCardClick, onMoved }: {
  candidates: Candidate[]
  t: typeof T['ua']['kanban']
  onCardClick: (c: Candidate) => void
  onMoved: (c: Candidate) => void
}) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<KanbanCol | null>(null)

  const cols: { id: KanbanCol; label: string }[] = [
    { id: 'tocontact',   label: t.tocontact },
    { id: 'contacted',   label: t.contacted },
    { id: 'interviewed', label: t.interviewed },
    { id: 'accepted',    label: t.accepted },
    { id: 'rejected',    label: t.rejected },
  ]

  async function drop(col: KanbanCol) {
    const id = dragId
    setOverCol(null)
    setDragId(null)
    if (id == null) return
    const cand = candidates.find(c => c.id === id)
    if (!cand || kanbanColumn(cand) === col) return
    const r = await api.candidates.setKanban(id, col)
    if (r.data) onMoved(r.data)
  }

  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', flex: 1, paddingBottom: 8 }}>
      {cols.map(col => {
        const items = candidates.filter(c => kanbanColumn(c) === col.id)
        return (
          <div
            key={col.id}
            onDragOver={e => { e.preventDefault(); setOverCol(col.id) }}
            onDragLeave={() => setOverCol(o => (o === col.id ? null : o))}
            onDrop={() => drop(col.id)}
            style={{
              flex: '1 0 196px', minWidth: 196, display: 'flex', flexDirection: 'column',
              borderRadius: 12, transition: 'background 120ms',
              background: overCol === col.id ? 'var(--surface-2)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 8px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: COL_COLOR[col.id] }} />
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{col.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{items.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'auto', padding: '0 4px 4px' }}>
              {items.map(c => (
                <div
                  key={c.id}
                  draggable
                  onDragStart={() => setDragId(c.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => onCardClick(c)}
                  style={{
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderLeft: `3px solid ${COL_COLOR[col.id]}`, borderRadius: 10,
                    padding: '9px 11px', cursor: 'pointer',
                    opacity: dragId === c.id ? 0.4 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.full_name || c.initials || '—'}
                    </span>
                    {c.qualification_score != null && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 7, background: 'var(--surface-2)', color: 'var(--text-2)' }}>
                        {c.qualification_score}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                    {c.role || c.location || ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
