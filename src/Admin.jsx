import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { ItemSheet } from './App'
import Setup from './Setup'

const ERRORS = {
  FORBIDDEN: 'This account is not set up as a barista.',
  NOT_FOUND: 'That order no longer exists.',
  NOT_CANCELLABLE: 'That order can no longer be cancelled.',
  NOT_IN_PROGRESS: 'That order is not in progress.',
  NOTHING_TO_UNDO: 'Nothing left to undo for that order.',
  STATE_CHANGED: 'That order just changed. Refreshing.',
  UNLIMITED_OR_NOT_FOUND: 'That item has unlimited stock.',
  NO_ACTIVE_SESSION: 'There is no active session.',
}
function explain(r) {
  const e = r?.error || ''
  const code = e.split(':')[0]
  const detail = e.includes(': ') ? e.split(': ').slice(1).join(': ') : ''
  if (code === 'NOT_PENDING') return r.claimed_by_name ? `Already claimed by ${r.claimed_by_name}.` : 'That order is no longer pending.'
  if (code === 'SOLD_OUT') return `Can't restore: ${detail} is out of stock.`
  if (code === 'OPTION_UNAVAILABLE') return `${detail} is turned off.`
  if (code === 'INVALID_ORDER') return detail || 'That order is not valid.'
  return ERRORS[code] || 'Something went wrong.'
}

export default function Admin() {
  const [me, setMe] = useState(undefined) // undefined = loading, null = signed out

  async function resolve(session) {
    if (!session) return setMe(null)
    const { data } = await supabase.from('admins').select('display_name').eq('user_id', session.user.id).maybeSingle()
    setMe({ id: session.user.id, name: data?.display_name || null })
  }
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => resolve(data.session))
    // setTimeout avoids running queries inside the auth callback itself
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setTimeout(() => resolve(s), 0))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (me === undefined) return <div className="wrap muted">Loading…</div>
  if (!me) return <Login />
  if (!me.name) return (
    <div className="wrap"><h1>Not a barista</h1>
      <p className="muted">You're signed in, but this account hasn't been added to the barista list yet.</p>
      <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
  )
  return <Dashboard me={me} />
}

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('')
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (err) setError('Email or password is incorrect.')
  }
  return (
    <form className="wrap" onSubmit={submit}>
      <h1>Barista sign in</h1>
      <input type="text" placeholder="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
        style={{ width: '100%', padding: 12, border: '1px solid var(--line)', borderRadius: 10, fontSize: 16, margin: '6px 0' }} />
      {error && <div className="err">{error}</div>}
      <button className="btn" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  )
}

const minutesSince = (ts, now) => Math.max(0, Math.floor((now - new Date(ts).getTime()) / 60000))

function Dashboard({ me }) {
  const [session, setSession] = useState(null)
  const [passcode, setPasscode] = useState('')
  const [orders, setOrders] = useState([])
  const [menu, setMenu] = useState([])
  const [conn, setConn] = useState('connecting')
  const [now, setNow] = useState(Date.now())
  const [toast, setToast] = useState(null) // { text, undoId }
  const [cancelling, setCancelling] = useState(null)
  const [walkIn, setWalkIn] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const [sound, setSound] = useState(false)
  const [setup, setSetup] = useState(false)
  const audio = useRef(null)
  const seen = useRef(null)
  const loadRef = useRef(() => {})
  const toastTimer = useRef(null)

  async function load() {
    const { data: s } = await supabase.from('sessions').select('*').eq('is_active', true).maybeSingle()
    setSession(s)
    if (!s) return
    const [sec, ord, men] = await Promise.all([
      supabase.from('session_secrets').select('passcode').eq('session_id', s.id).maybeSingle(),
      supabase.from('orders').select('*, claimer:admins(display_name), order_items(*, order_item_modifiers(*))').eq('session_id', s.id).order('created_at'),
      supabase.from('menu_items').select('*, menu_item_modifier_groups(modifier_groups(*, modifier_options(*)))').eq('session_id', s.id).order('sort_order'),
    ])
    setPasscode(sec.data?.passcode || '')
    const list = ord.data || []
    setOrders(list)
    setMenu(men.data || [])
    // chime for genuinely new pending orders (not on first load)
    const ids = new Set(list.map((o) => o.id))
    if (seen.current) {
      const fresh = list.some((o) => o.status === 'pending' && !seen.current.has(o.id))
      if (fresh) beep()
    }
    seen.current = ids
  }
  loadRef.current = load

  useEffect(() => {
    loadRef.current()
    const ch = supabase.channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => loadRef.current())
      .subscribe((st) => {
        setConn(st === 'SUBSCRIBED' ? 'online' : 'offline')
        if (st === 'SUBSCRIBED') loadRef.current() // full resync on every (re)connect
      })
    const poll = setInterval(() => loadRef.current(), 10000) // fallback if realtime is flaky
    const tick = setInterval(() => setNow(Date.now()), 30000)
    const onVis = () => { if (!document.hidden) loadRef.current() }
    document.addEventListener('visibilitychange', onVis)
    return () => { supabase.removeChannel(ch); clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  function enableSound() {
    audio.current = new (window.AudioContext || window.webkitAudioContext)()
    setSound(true); beep()
  }
  function beep() {
    const c = audio.current
    if (!c) return
    const o = c.createOscillator(), g = c.createGain()
    o.connect(g); g.connect(c.destination); o.frequency.value = 880
    g.gain.setValueAtTime(0.25, c.currentTime); g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.6)
    o.start(); o.stop(c.currentTime + 0.6)
  }

  function say(text, undoId) {
    clearTimeout(toastTimer.current)
    setToast({ text, undoId })
    toastTimer.current = setTimeout(() => setToast(null), 10000)
  }
  async function act(fn, args, okText, undoable = true) {
    const { data, error } = await supabase.rpc(fn, args)
    if (error || !data) say('Could not reach the server. Check the connection.')
    else if (!data.ok) say(explain(data))
    else say(okText, undoable ? args.p_order_id : null)
    await load()
  }
  const undo = async (id) => { setToast(null); await act('undo_order', { p_order_id: id }, 'Undone.', false) }

  const itemInfo = Object.fromEntries(menu.map((m) => [m.id, m]))
  const by = (st) => orders.filter((o) => o.status === st)
  const pending = by('pending')
  const progress = by('in_progress')
  const done = by('completed').slice(-15).reverse()
  const cancelled = by('cancelled').reverse()

  function Card({ o }) {
    const allergens = [...new Set(o.order_items.flatMap((i) => itemInfo[i.menu_item_id]?.allergens || []))]
    const waiting = o.status === 'pending' ? minutesSince(o.created_at, now) : null
    return (
      <div className={'ocard' + (o.claimed_by === me.id && o.status === 'in_progress' ? ' mine' : '')}>
        <div className="row">
          <div><span className="tk">#{o.ticket_number}</span><strong>{o.customer_name}</strong>{o.source === 'barista' && <span className="tag" style={{ marginLeft: 6 }}>walk-in</span>}</div>
          <span className={waiting >= 10 ? 'late' : waiting >= 5 ? 'warn' : 'muted'}>{waiting !== null ? `${waiting} min` : ''}</span>
        </div>
        {o.order_items.sort((a, b) => a.line_number - b.line_number).map((i) => (
          <div key={i.id} style={{ marginTop: 6 }}>
            <strong>{i.quantity} × {i.item_name}</strong>
            {i.order_item_modifiers.length > 0 && <div className="muted">{i.order_item_modifiers.map((m) => m.option_name).join(', ')}</div>}
            {i.note && <div className="muted">“{i.note}”</div>}
          </div>
        ))}
        {allergens.length > 0 && <div className="allergen">Allergens: {allergens.join(', ')}</div>}
        {o.status === 'in_progress' && <div className="muted" style={{ marginTop: 4 }}>Claimed by {o.claimer?.display_name || '—'}</div>}
        {o.status === 'cancelled' && <div className="muted" style={{ marginTop: 4 }}>Cancelled by {o.cancelled_by}{o.cancel_reason ? `: ${o.cancel_reason}` : ''}</div>}
        <div className="acts">
          {o.status === 'pending' && <button className="btn sm" onClick={() => act('start_order', { p_order_id: o.id }, `Started #${o.ticket_number}.`)}>Start</button>}
          {o.status === 'in_progress' && <button className="btn sm" onClick={() => act('complete_order', { p_order_id: o.id }, `Completed #${o.ticket_number}.`)}>Complete</button>}
          {['pending', 'in_progress'].includes(o.status) && <button className="btn sm ghost" onClick={() => setCancelling(o)}>Cancel</button>}
          {['completed', 'cancelled'].includes(o.status) && <button className="btn sm ghost" onClick={() => undo(o.id)}>Undo</button>}
        </div>
      </div>
    )
  }

  if (setup) return <Setup onClose={() => { setSetup(false); load() }} />
  if (!session) return (
    <div className="adm"><h1>No active session</h1>
      <p className="muted">Create or activate a session to start taking orders.</p>
      <button className="btn" onClick={() => setSetup(true)}>Menu & sessions</button></div>
  )

  const setSessionField = async (patch) => { await supabase.from('sessions').update(patch).eq('id', session.id); await load() }
  const rotate = async () => {
    if (!confirm('Change the passcode? Guests will need the new one.')) return
    const { data } = await supabase.rpc('rotate_passcode', { p_session_id: session.id })
    if (data?.ok) say(`New passcode: ${data.passcode}`)
    await load()
  }

  return (
    <div className="adm">
      <div className="adm-top">
        <div>
          <h2 style={{ margin: 0 }}>{session.title}</h2>
          <span title={conn}><span className={'dot' + (conn === 'online' ? '' : ' off')} /> <span className="muted">{conn === 'online' ? 'Live' : 'Reconnecting…'}</span></span>
          <select value={session.status} onChange={(e) => setSessionField({ status: e.target.value })}>
            <option value="upcoming">Not open yet</option><option value="open">Open</option><option value="closed">Closed</option>
          </select>
          <button className={'btn' + (session.ordering_paused ? '' : ' ghost')} onClick={() => setSessionField({ ordering_paused: !session.ordering_paused })}>
            {session.ordering_paused ? 'Ordering PAUSED (tap to resume)' : 'Pause ordering'}
          </button>
        </div>
        <div>
          <span>Code: <strong style={{ fontSize: 20, letterSpacing: 2 }}>{passcode}</strong></span>
          <button className="btn ghost sm" onClick={rotate}>Change</button>
          <button className="btn ghost sm" onClick={sound ? () => setSound(false) : enableSound}>{sound ? '🔔 Sound on' : '🔕 Sound off'}</button>
          <button className="btn ghost" onClick={() => setSetup(true)}>Menu & sessions</button>
          <button className="btn" onClick={() => setWalkIn(true)}>+ New order</button>
          <button className="btn ghost sm" onClick={() => supabase.auth.signOut()}>Sign out ({me.name})</button>
        </div>
      </div>
      {conn !== 'online' && <div className="err">Connection lost. Orders may be out of date. Reconnecting…</div>}

      <div className="adm-grid">
        <div className="col"><h2>Pending ({pending.length})</h2>{pending.map((o) => <Card key={o.id} o={o} />)}</div>
        <div className="col"><h2>In progress ({progress.length})</h2>{progress.map((o) => <Card key={o.id} o={o} />)}</div>
        <div className="col">
          <h2>Complete</h2>{done.map((o) => <Card key={o.id} o={o} />)}
          <button className="btn ghost sm" onClick={() => setShowCancelled(!showCancelled)}>{showCancelled ? 'Hide' : 'Show'} cancelled ({cancelled.length})</button>
          {showCancelled && <div style={{ marginTop: 8 }}>{cancelled.map((o) => <Card key={o.id} o={o} />)}</div>}
        </div>
        <div className="col">
          <h2>Inventory</h2>
          {menu.map((m) => (
            <div className="inv" key={m.id}>
              <div style={{ opacity: m.is_available ? 1 : 0.5 }}>{m.name}<div className="muted">{m.stock_count === null ? 'unlimited' : `${m.stock_count} left`}</div></div>
              <div>
                {m.stock_count !== null && <><button className="btn sm ghost" onClick={() => act('adjust_stock', { p_menu_item_id: m.id, p_delta: -1 }, '', false)}>−</button>{' '}
                  <button className="btn sm ghost" onClick={() => act('adjust_stock', { p_menu_item_id: m.id, p_delta: 1 }, '', false)}>+</button>{' '}</>}
                <button className="btn sm ghost" onClick={async () => { await supabase.from('menu_items').update({ is_available: !m.is_available }).eq('id', m.id); load() }}>{m.is_available ? '86' : 'Show'}</button>
              </div>
            </div>
          ))}
          <h2 style={{ marginTop: 16 }}>Options</h2>
          {[...new Map(menu.flatMap((m) => m.menu_item_modifier_groups.map((l) => l.modifier_groups)).filter(Boolean).map((g) => [g.id, g])).values()].map((g) => (
            <div key={g.id}><strong>{g.name}</strong>
              {g.modifier_options.sort((a, b) => a.sort_order - b.sort_order).map((o) => (
                <div className="inv" key={o.id}><span style={{ opacity: o.is_available ? 1 : 0.5 }}>{o.name}</span>
                  <button className="btn sm ghost" onClick={async () => { await supabase.from('modifier_options').update({ is_available: !o.is_available }).eq('id', o.id); load() }}>{o.is_available ? 'Turn off' : 'Turn on'}</button></div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {cancelling && <CancelDialog order={cancelling} onClose={() => setCancelling(null)}
        onConfirm={async (reason, restock) => { const o = cancelling; setCancelling(null); await act('cancel_order', { p_order_id: o.id, p_reason: reason, p_restock: restock }, `Cancelled #${o.ticket_number}.`) }} />}
      {walkIn && <WalkIn menu={menu} onClose={() => setWalkIn(false)} onDone={(t) => { setWalkIn(false); say(t, null); load() }} />}
      {toast && <div className="toast">{toast.text}{toast.undoId && <button onClick={() => undo(toast.undoId)}>Undo</button>}</div>}
    </div>
  )
}

function CancelDialog({ order, onClose, onConfirm }) {
  const [reason, setReason] = useState('')
  const [restock, setRestock] = useState(order.status === 'pending') // default on for pending, off once started
  return (
    <div className="modal" onClick={onClose}><div onClick={(e) => e.stopPropagation()}>
      <h2>Cancel #{order.ticket_number} ({order.customer_name})?</h2>
      <input type="text" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <label className="opt"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Return items to stock</label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn ghost" onClick={onClose}>Keep order</button>
        <button className="btn" onClick={() => onConfirm(reason, restock)}>Cancel order</button>
      </div>
    </div></div>
  )
}

function WalkIn({ menu, onClose, onDone }) {
  const [cart, setCart] = useState([])
  const [name, setName] = useState('')
  const [picking, setPicking] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(startNow) {
    setBusy(true); setError('')
    const items = cart.map((l) => ({ menu_item_id: l.itemId, quantity: l.qty, note: l.note || null, modifier_option_ids: l.optionIds }))
    const { data, error: e } = await supabase.rpc('admin_place_order', { p_name: name, p_items: items, p_start_now: startNow })
    setBusy(false)
    if (e || !data) return setError('Could not reach the server.')
    if (!data.ok) return setError(explain(data))
    onDone(`Added #${data.ticket_number}.`)
  }
  return (
    <div className="modal" onClick={onClose}><div onClick={(e) => e.stopPropagation()}>
      <h2>New walk-in order</h2>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
        {menu.map((m) => {
          const out = !m.is_available || m.stock_count === 0
          return <button key={m.id} className="btn ghost sm" disabled={out} onClick={() => setPicking(m)}>{m.name}{out ? ' (out)' : ''}</button>
        })}
      </div>
      {cart.map((l) => (
        <div className="row" key={l.key} style={{ margin: '4px 0' }}>
          <span>{l.qty} × {l.name}{l.optionNames.length ? ` (${l.optionNames.join(', ')})` : ''}{l.note ? ` “${l.note}”` : ''}</span>
          <button className="btn sm ghost" onClick={() => setCart(cart.filter((x) => x.key !== l.key))}>Remove</button>
        </div>
      ))}
      <input type="text" placeholder="Name (leave blank for Walk-in)" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      {error && <div className="err">{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn ghost" onClick={onClose}>Close</button>
        <span>
          <button className="btn ghost" disabled={busy || !cart.length} onClick={() => submit(false)}>Add to pending</button>{' '}
          <button className="btn" disabled={busy || !cart.length} onClick={() => submit(true)}>Start now</button>
        </span>
      </div>
      {picking && <ItemSheet item={picking} onClose={() => setPicking(null)} onAdd={(line) => { setCart([...cart, line]); setPicking(null) }} />}
    </div></div>
  )
}
