import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const THEMES = ['default', 'fall-cozy'] // add a theme: new block in styles.css, then add its name here
const csv = (a) => (a || []).join(', ')
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)
const num = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n }

export default function Setup({ onClose }) {
  const [sessions, setSessions] = useState([])
  const [selId, setSelId] = useState(null)
  const [tab, setTab] = useState('session')
  const [data, setData] = useState({ items: [], groups: [] })
  const [note, setNote] = useState('')

  async function loadSessions(pick) {
    const { data: s } = await supabase.from('sessions').select('*').order('created_at', { ascending: false })
    setSessions(s || [])
    setSelId((cur) => pick || cur || (s?.find((x) => x.is_active) || s?.[0])?.id || null)
  }
  async function loadData(id) {
    if (!id) return setData({ items: [], groups: [] })
    const [it, gr] = await Promise.all([
      supabase.from('menu_items').select('*, menu_item_modifier_groups(group_id)').eq('session_id', id).order('sort_order'),
      supabase.from('modifier_groups').select('*, modifier_options(*)').eq('session_id', id).order('sort_order'),
    ])
    setData({ items: it.data || [], groups: gr.data || [] })
  }
  useEffect(() => { loadSessions() }, [])
  useEffect(() => { loadData(selId) }, [selId])

  const sel = sessions.find((s) => s.id === selId)
  const reload = async () => { await loadSessions(); await loadData(selId) }
  const flash = (t) => { setNote(t); setTimeout(() => setNote(''), 4000) }
  const done = async (error, okText = 'Saved.') => { if (error) flash(error.message); else { flash(okText); await reload() } }

  async function newSession() {
    const { data: row, error } = await supabase.from('sessions').insert({ title: 'New session' }).select().single()
    if (error) return flash(error.message)
    await loadSessions(row.id); flash('Created. Fill in the details below.')
  }
  async function duplicate() {
    const { data: r, error } = await supabase.rpc('duplicate_session', { p_session_id: sel.id, p_title: null })
    if (error || !r?.ok) return flash(error?.message || 'Could not duplicate. Did you run 005_duplicate_session.sql?')
    await loadSessions(r.session_id); flash('Duplicated into a new inactive session.')
  }
  async function makeActive() {
    const { data: r } = await supabase.rpc('activate_session', { p_session_id: sel.id })
    flash(r?.ok ? 'This session is now active.' : 'Could not activate.'); await reload()
  }
  async function remove() {
    if (sel.is_active) return flash('Make another session active before deleting this one.')
    if (!confirm(`Delete "${sel.title}" and all of its orders? This cannot be undone.`)) return
    const { error } = await supabase.from('sessions').delete().eq('id', sel.id)
    if (error) return flash(error.message)
    setSelId(null); await loadSessions()
  }

  return (
    <div className="adm setup">
      <div className="row" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Menu & sessions</h1>
        <button className="btn" onClick={onClose}>← Back to orders</button>
      </div>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={selId || ''} onChange={(e) => setSelId(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}{s.is_active ? ' (active)' : ''}</option>)}
          </select>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm ghost" onClick={newSession}>New</button>
            {sel && <>
              <button className="btn sm ghost" onClick={duplicate}>Duplicate</button>
              {!sel.is_active && <button className="btn sm" onClick={makeActive}>Make active</button>}
              <button className="btn sm ghost" onClick={remove}>Delete</button>
            </>}
          </span>
        </div>
        {note && <div className="banner">{note}</div>}
      </div>

      {!sel ? <p className="muted">Create a session to get started.</p> : <>
        <div className="steps" style={{ margin: '8px 0' }}>
          {[['session', 'Session'], ['menu', 'Menu items'], ['mods', 'Modifiers']].map(([k, l]) =>
            <div key={k} className={tab === k ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab(k)}>{l}</div>)}
        </div>
        {tab === 'session' && <SessionForm key={sel.id} s={sel} done={done} />}
        {tab === 'menu' && <>
          {data.items.map((it) => <ItemCard key={it.id} item={it} groups={data.groups} done={done} />)}
          <button className="btn" onClick={async () => done(
            (await supabase.from('menu_items').insert({ session_id: sel.id, name: 'New item', stock_count: 10, sort_order: data.items.length + 1 })).error, 'Item added.')}>+ Add item</button>
        </>}
        {tab === 'mods' && <>
          <p className="muted">Create a group once (like Milk), then attach it to items on the Menu items tab.</p>
          {data.groups.map((g) => <GroupCard key={g.id} g={g} done={done} />)}
          <button className="btn" onClick={async () => done(
            (await supabase.from('modifier_groups').insert({ session_id: sel.id, name: 'New group', sort_order: data.groups.length + 1 })).error, 'Group added.')}>+ Add modifier group</button>
        </>}
      </>}
    </div>
  )
}

function SessionForm({ s, done }) {
  const [d, setD] = useState(s)
  const bind = (k) => ({ value: d[k] ?? '', onChange: (e) => setD({ ...d, [k]: e.target.value }) })
  const save = () => supabase.from('sessions').update({
    title: d.title, theme_slug: d.theme_slug, description: d.description, venue_note: d.venue_note,
    zelle_contact: d.zelle_contact || null, venmo_handle: d.venmo_handle || null, tip_note: d.tip_note || null,
    guestbook_url: d.guestbook_url || null, tips_enabled: d.tips_enabled,
    low_stock_threshold: Math.max(0, num(d.low_stock_threshold) ?? 5),
    max_items_per_order: Math.max(1, num(d.max_items_per_order) ?? 10),
    max_open_orders: num(d.max_open_orders), max_open_orders_per_name: num(d.max_open_orders_per_name),
  }).eq('id', s.id).then(({ error }) => done(error))
  return (
    <div className="card">
      <label>Title</label><input type="text" {...bind('title')} />
      <label>Theme</label>
      <select value={d.theme_slug} onChange={(e) => setD({ ...d, theme_slug: e.target.value })}>{THEMES.map((t) => <option key={t}>{t}</option>)}</select>
      <label>Description (the vibe)</label><textarea rows={2} {...bind('description')} />
      <label>Venue note (shown to guests; keep your exact address out if you want it private)</label><textarea rows={2} {...bind('venue_note')} />
      <div className="grid2">
        <div><label>Zelle phone or email</label><input type="text" {...bind('zelle_contact')} /></div>
        <div><label>Venmo handle (no @)</label><input type="text" {...bind('venmo_handle')} /></div>
      </div>
      <label>Tip jar message</label><input type="text" {...bind('tip_note')} />
      <label>Guestbook link</label><input type="text" {...bind('guestbook_url')} />
      <label className="opt"><input type="checkbox" checked={d.tips_enabled} onChange={(e) => setD({ ...d, tips_enabled: e.target.checked })} /> Show the tip jar</label>
      <div className="grid2">
        <div><label>"Running low" at this many or fewer</label><input type="text" inputMode="numeric" {...bind('low_stock_threshold')} /></div>
        <div><label>Max items per order</label><input type="text" inputMode="numeric" {...bind('max_items_per_order')} /></div>
        <div><label>Max open orders (blank = no cap)</label><input type="text" inputMode="numeric" {...bind('max_open_orders')} /></div>
        <div><label>Max open orders per name (blank = no cap)</label><input type="text" inputMode="numeric" {...bind('max_open_orders_per_name')} /></div>
      </div>
      <button className="btn" style={{ marginTop: 12 }} onClick={save}>Save session</button>
    </div>
  )
}

function ItemCard({ item, groups, done }) {
  const [d, setD] = useState({ name: item.name, description: item.description || '', ingredients: csv(item.ingredients),
    allergens: csv(item.allergens), stock: item.stock_count ?? '', sort: item.sort_order })
  const bind = (k) => ({ value: d[k], onChange: (e) => setD({ ...d, [k]: e.target.value }) })
  const attached = (gid) => item.menu_item_modifier_groups.some((l) => l.group_id === gid)
  const save = () => supabase.from('menu_items').update({
    name: d.name, description: d.description, ingredients: list(d.ingredients), allergens: list(d.allergens),
    stock_count: num(d.stock) === null ? null : Math.max(0, num(d.stock)), sort_order: num(d.sort) ?? 0,
  }).eq('id', item.id).then(({ error }) => done(error))
  const toggle = async (gid) => {
    const q = attached(gid)
      ? supabase.from('menu_item_modifier_groups').delete().match({ menu_item_id: item.id, group_id: gid })
      : supabase.from('menu_item_modifier_groups').insert({ menu_item_id: item.id, group_id: gid })
    done((await q).error, 'Updated.')
  }
  const del = async () => {
    if (!confirm(`Delete "${item.name}"?`)) return
    const { error } = await supabase.from('menu_items').delete().eq('id', item.id)
    done(error && (error.code === '23503' ? { message: 'This item has past orders, so it can\'t be deleted. Use 86 on the orders screen to hide it.' } : error), 'Deleted.')
  }
  return (
    <div className="card">
      <div className="grid2">
        <div><label>Name</label><input type="text" {...bind('name')} /></div>
        <div className="grid2">
          <div><label>Stock (blank = unlimited)</label><input type="text" inputMode="numeric" {...bind('stock')} /></div>
          <div><label>Order on menu</label><input type="text" inputMode="numeric" {...bind('sort')} /></div>
        </div>
      </div>
      <label>Description</label><textarea rows={2} {...bind('description')} />
      <div className="grid2">
        <div><label>Ingredients (comma separated)</label><input type="text" {...bind('ingredients')} /></div>
        <div><label>Allergens (comma separated)</label><input type="text" {...bind('allergens')} /></div>
      </div>
      {groups.length > 0 && <div style={{ marginTop: 8 }}><label>Modifier groups on this item</label>
        {groups.map((g) => <label className="opt" key={g.id}><input type="checkbox" checked={attached(g.id)} onChange={() => toggle(g.id)} /> {g.name}</label>)}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm ghost" onClick={del}>Delete</button>
        <button className="btn sm" onClick={save}>Save item</button>
      </div>
    </div>
  )
}

function GroupCard({ g, done }) {
  const [d, setD] = useState({ name: g.name, required: g.is_required, max: g.max_select })
  const [newOpt, setNewOpt] = useState('')
  const save = () => supabase.from('modifier_groups').update({
    name: d.name, is_required: d.required, min_select: d.required ? 1 : 0, max_select: Math.max(1, num(d.max) ?? 1),
  }).eq('id', g.id).then(({ error }) => done(error))
  const del = async () => { if (confirm(`Delete group "${g.name}" and its options?`)) done((await supabase.from('modifier_groups').delete().eq('id', g.id)).error, 'Deleted.') }
  const addOpt = async () => {
    if (!newOpt.trim()) return
    const { error } = await supabase.from('modifier_options').insert({ group_id: g.id, name: newOpt.trim(), sort_order: g.modifier_options.length + 1 })
    setNewOpt(''); done(error, 'Option added.')
  }
  return (
    <div className="card">
      <div className="grid2">
        <div><label>Group name</label><input type="text" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div><label>Guests can pick up to</label><input type="text" inputMode="numeric" value={d.max} onChange={(e) => setD({ ...d, max: e.target.value })} /></div>
      </div>
      <label className="opt"><input type="checkbox" checked={d.required} onChange={(e) => setD({ ...d, required: e.target.checked })} /> Required (guest must choose)</label>
      <label>Options</label>
      {g.modifier_options.sort((a, b) => a.sort_order - b.sort_order).map((o) => (
        <div className="row" key={o.id}>
          <input type="text" defaultValue={o.name} onBlur={async (e) => { const v = e.target.value.trim(); if (v && v !== o.name) done((await supabase.from('modifier_options').update({ name: v }).eq('id', o.id)).error) }} />
          <button className="btn sm ghost" onClick={async () => done((await supabase.from('modifier_options').delete().eq('id', o.id)).error, 'Removed.')}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input type="text" placeholder="New option (e.g. Oat)" value={newOpt} onChange={(e) => setNewOpt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addOpt()} />
        <button className="btn sm ghost" onClick={addOpt}>Add</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm ghost" onClick={del}>Delete group</button>
        <button className="btn sm" onClick={save}>Save group</button>
      </div>
    </div>
  )
}
