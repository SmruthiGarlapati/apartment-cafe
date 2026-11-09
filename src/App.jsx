import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* storage can be unavailable */ } },
}

const MESSAGES = {
  NO_ACTIVE_SESSION: 'The cafe is not open right now.',
  ORDERING_CLOSED: 'Ordering is closed right now.',
  ORDERING_PAUSED: 'Ordering is paused for a moment.',
  WRONG_PASSCODE: "That code isn't right. Check the sign at the cafe.",
  TOO_MANY_ATTEMPTS: 'Too many wrong codes. Please wait 30 seconds and try again.',
  TOO_MANY_ITEMS: 'That is too many items for one order.',
  AT_CAPACITY: 'We are swamped right now. Try again in a few minutes.',
  TOO_MANY_OPEN_ORDERS: 'You already have open orders under that name.',
}
function friendly(r) {
  const e = r?.error || ''
  const code = e.split(':')[0]
  const detail = e.includes(': ') ? e.split(': ').slice(1).join(': ') : ''
  if (code === 'SOLD_OUT') return `Sorry, ${detail} just sold out. Please update your order.`
  if (code === 'OPTION_UNAVAILABLE') return `Sorry, ${detail} is out right now. Please pick another option.`
  if (code === 'INVALID_ORDER') return detail || 'Something is off with that order.'
  if (code === 'ORDERING_PAUSED' && r.message) return r.message
  return MESSAGES[code] || 'Something went wrong. Please try again.'
}

function stockLabel(item, threshold) {
  if (!item.is_available || item.stock_count === 0) return 'Sold out'
  if (item.stock_count !== null && item.stock_count <= threshold) return 'Running low'
  return null
}

const groupsOf = (item) =>
  (item.menu_item_modifier_groups || []).map((l) => l.modifier_groups).filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order)

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = loading, null = none
  const [items, setItems] = useState([])
  const [cart, setCart] = useState(() => store.get('cart', []))
  const [token, setToken] = useState(() => location.hash.startsWith('#t=') ? location.hash.slice(3) : store.get('orderToken', null))
  const [view, setView] = useState(token ? 'order' : 'menu') // menu | checkout | order
  const [picking, setPicking] = useState(null)

  async function loadMenu() {
    const { data: s } = await supabase.from('sessions').select('*').maybeSingle()
    setSession(s || null)
    if (!s) return
    document.documentElement.dataset.theme = s.theme_slug
    const { data } = await supabase
      .from('menu_items')
      .select('*, menu_item_modifier_groups(modifier_groups(*, modifier_options(*)))')
      .order('sort_order')
    setItems(data || [])
  }

  useEffect(() => {
    loadMenu()
    const id = setInterval(() => { if (!document.hidden) loadMenu() }, 15000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => store.set('cart', cart), [cart])

  if (session === undefined) return <div className="wrap muted">Loading…</div>
  if (session === null) return <div className="wrap"><h1>Apartment Cafe</h1><p className="muted">No cafe is open right now. Check back soon!</p></div>

  const placed = (t) => { setToken(t); store.set('orderToken', t); setCart([]); setView('order'); location.hash = 't=' + t }
  const closeOrder = () => { setView('menu'); history.replaceState(null, '', location.pathname) }

  if (view === 'order' && token) return <Tracker token={token} onBack={closeOrder} onForget={() => { setToken(null); store.set('orderToken', null); closeOrder() }} />

  const count = cart.reduce((n, l) => n + l.qty, 0)
  const closed = session.status !== 'open'
  const paused = session.ordering_paused

  if (view === 'checkout') return <Checkout session={session} cart={cart} setCart={setCart} onBack={() => setView('menu')} onPlaced={placed} />

  return (
    <div className="wrap">
      <h1>{session.title}</h1>
      <div className="muted">{session.description}</div>
      <div className="muted">{session.venue_note}</div>
      {token && <div className="card row"><span>You have an order in.</span><button className="btn ghost" style={{ width: 'auto' }} onClick={() => setView('order')}>View order</button></div>}
      {closed && <div className="banner">Ordering is {session.status === 'upcoming' ? 'not open yet' : 'closed'}. You can still browse the menu.</div>}
      {!closed && paused && <div className="banner">{session.pause_message || 'Ordering is paused for a moment.'}</div>}
      <p className="muted">Made in a home kitchen. Please check allergens before you order.</p>
      {items.map((it) => {
        const label = stockLabel(it, session.low_stock_threshold)
        const out = label === 'Sold out'
        return (
          <div className="card" key={it.id} style={{ opacity: out ? 0.6 : 1 }}>
            <div className="row"><h2>{it.name}</h2>{label && <span className={'tag ' + (out ? 'out' : 'low')}>{label}</span>}</div>
            <div className="muted">{it.description}</div>
            {it.allergens?.length > 0 && <div className="muted">Contains: {it.allergens.join(', ')}</div>}
            <button className="btn" style={{ marginTop: 10 }} disabled={out || closed || paused} onClick={() => setPicking(it)}>Add</button>
          </div>
        )
      })}
      {picking && <ItemSheet item={picking} onClose={() => setPicking(null)} onAdd={(line) => { setCart([...cart, line]); setPicking(null) }} />}
      {count > 0 && <div className="bar"><button className="btn" onClick={() => setView('checkout')}>Review order ({count})</button></div>}
    </div>
  )
}

function ItemSheet({ item, onClose, onAdd }) {
  const groups = groupsOf(item)
  const [picked, setPicked] = useState({}) // groupId -> [optionId]
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')

  const toggle = (g, id) => {
    const cur = picked[g.id] || []
    let next
    if (g.max_select === 1) next = [id]
    else if (cur.includes(id)) next = cur.filter((x) => x !== id)
    else next = cur.length < g.max_select ? [...cur, id] : cur
    setPicked({ ...picked, [g.id]: next })
  }
  const valid = groups.every((g) => { const n = (picked[g.id] || []).length; return n >= g.min_select && n <= g.max_select })
  const optionIds = Object.values(picked).flat()
  const optionNames = groups.flatMap((g) => (g.modifier_options || []).filter((o) => (picked[g.id] || []).includes(o.id)).map((o) => o.name))

  return (
    <div className="sheet" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <h2>{item.name}</h2>
        <div className="muted">{item.description}</div>
        {item.ingredients?.length > 0 && <div className="muted">Ingredients: {item.ingredients.join(', ')}</div>}
        {groups.map((g) => (
          <div key={g.id} style={{ marginTop: 14 }}>
            <strong>{g.name}</strong> <span className="muted">{g.min_select >= 1 ? 'Required' : `Optional, up to ${g.max_select}`}</span>
            {(g.modifier_options || []).sort((a, b) => a.sort_order - b.sort_order).map((o) => (
              <label className="opt" key={o.id} style={{ opacity: o.is_available ? 1 : 0.5 }}>
                <input type={g.max_select === 1 ? 'radio' : 'checkbox'} name={g.id} disabled={!o.is_available}
                  checked={(picked[g.id] || []).includes(o.id)} onChange={() => toggle(g, o.id)} />
                {o.name}{!o.is_available && ' (out)'}
              </label>
            ))}
          </div>
        ))}
        <textarea rows={2} maxLength={200} placeholder="Notes (e.g. no nuts, extra ice)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ margin: '10px 0' }}>
          <div>
            <button className="btn ghost" style={{ width: 44 }} onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
            <strong style={{ margin: '0 14px' }}>{qty}</strong>
            <button className="btn ghost" style={{ width: 44 }} onClick={() => setQty(Math.min(10, qty + 1))}>+</button>
          </div>
        </div>
        <button className="btn" disabled={!valid} onClick={() => onAdd({ key: crypto.randomUUID(), itemId: item.id, name: item.name, qty, note: note.trim(), optionIds, optionNames })}>
          Add to order
        </button>
      </div>
    </div>
  )
}

function Checkout({ session, cart, setCart, onBack, onPlaced }) {
  const [name, setName] = useState(() => store.get('name', ''))
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true); setError('')
    store.set('name', name)
    const items = cart.map((l) => ({ menu_item_id: l.itemId, quantity: l.qty, note: l.note || null, modifier_option_ids: l.optionIds }))
    const { data, error: e } = await supabase.rpc('place_order', { p_passcode: code, p_name: name, p_items: items })
    setBusy(false)
    if (e || !data) return setError('Could not reach the cafe. Check your connection and try again.')
    if (!data.ok) return setError(friendly(data))
    onPlaced(data.public_token)
  }

  return (
    <div className="wrap">
      <button className="btn ghost" style={{ width: 'auto' }} onClick={onBack}>← Menu</button>
      <h1>Your order</h1>
      {cart.length === 0 && <p className="muted">Your order is empty.</p>}
      {cart.map((l) => (
        <div className="card row" key={l.key}>
          <div><strong>{l.qty} × {l.name}</strong>
            {l.optionNames.length > 0 && <div className="muted">{l.optionNames.join(', ')}</div>}
            {l.note && <div className="muted">“{l.note}”</div>}</div>
          <button className="btn ghost" style={{ width: 'auto' }} onClick={() => setCart(cart.filter((x) => x.key !== l.key))}>Remove</button>
        </div>
      ))}
      <div className="card">
        <strong>I'm here!</strong>
        <div className="muted">Orders open once you're at the cafe. Enter the 4-digit code posted at the venue.</div>
        <input type="text" maxLength={40} placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="tel" inputMode="numeric" maxLength={4} placeholder="4-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      {error && <div className="err">{error}</div>}
      <div className="bar">
        <button className="btn" disabled={busy || cart.length === 0 || !name.trim() || code.length !== 4} onClick={submit}>{busy ? 'Placing order…' : 'Place order'}</button>
      </div>
    </div>
  )
}

const STEPS = [['pending', 'Received'], ['in_progress', 'Being made'], ['completed', 'Ready']]

function Tracker({ token, onBack, onForget }) {
  const [d, setD] = useState(null)
  const [offline, setOffline] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function poll() {
    const { data, error } = await supabase.rpc('get_order', { p_token: token })
    if (error) return setOffline(true)
    setOffline(false); setD(data)
  }
  useEffect(() => {
    poll()
    const id = setInterval(() => { if (!document.hidden) poll() }, 6000)
    return () => clearInterval(id)
  }, [token])

  async function cancel() {
    if (!confirm('Cancel your order?')) return
    setBusy(true)
    const { data } = await supabase.rpc('cancel_order_as_guest', { p_token: token })
    setBusy(false)
    if (data && !data.ok && data.error === 'NOT_PENDING') setMsg("We've already started your order. Please find a barista to cancel.")
    await poll()
  }

  if (!d) return <div className="wrap muted">{offline ? 'Reconnecting…' : 'Loading your order…'}</div>
  if (!d.ok) return <div className="wrap"><p>We couldn't find that order.</p><button className="btn" onClick={onForget}>Back to menu</button></div>

  const o = d.order, s = d.session
  const stepIdx = STEPS.findIndex(([k]) => k === o.status)
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => setMsg('Copied!'))

  return (
    <div className="wrap">
      {offline && <div className="banner">Reconnecting…</div>}
      <div className="muted">{s.title}</div>
      <div className="ticket">#{o.ticket_number}</div>
      <h2>{o.customer_name}</h2>

      {o.status === 'cancelled' ? (
        <div className="card">This order was cancelled{o.cancelled_by === 'barista' ? ' by a barista' : ''}.</div>
      ) : (
        <>
          <div className="steps">{STEPS.map(([k, label], i) => <div key={k} className={i <= stepIdx ? 'on' : ''}>{label}</div>)}</div>
          {o.status === 'pending' && <div className="muted">{o.orders_ahead > 0 ? `${o.orders_ahead} order${o.orders_ahead > 1 ? 's' : ''} ahead of you` : "You're next up!"}</div>}
          {o.status === 'in_progress' && <div className="muted">We're making your order now.</div>}
          {o.status === 'completed' && <div className="banner"><strong>Ready for pickup!</strong> We'll call “{o.customer_name}, #{o.ticket_number}” and set it on the counter.</div>}
        </>
      )}

      <div className="card">
        {o.items.map((it, i) => (
          <div key={i}><strong>{it.quantity} × {it.name}</strong>
            {it.modifiers.length > 0 && <div className="muted">{it.modifiers.map((m) => m.option).join(', ')}</div>}
            {it.note && <div className="muted">“{it.note}”</div>}</div>
        ))}
      </div>

      {msg && <div className="banner">{msg}</div>}
      {o.status === 'pending' && <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel order</button>}
      {o.status === 'in_progress' && <p className="muted">Need to cancel? Please find a barista.</p>}

      {s.tips_enabled && (s.zelle_contact || s.venmo_handle) && o.status !== 'cancelled' && (
        <div className="card">
          <strong>Tip jar</strong>
          <div className="muted">{s.tip_note || 'Tips are never expected, always appreciated.'}</div>
          {s.zelle_contact && <button className="btn" style={{ marginTop: 8 }} onClick={() => copy(s.zelle_contact)}>Copy Zelle: {s.zelle_contact}</button>}
          {s.venmo_handle && <a href={`https://venmo.com/u/${s.venmo_handle}`} target="_blank" rel="noreferrer"><button className="btn ghost" style={{ marginTop: 8 }}>Venmo @{s.venmo_handle}</button></a>}
        </div>
      )}
      {s.guestbook_url && o.status === 'completed' && <a href={s.guestbook_url} target="_blank" rel="noreferrer"><button className="btn ghost">Sign the guestbook</button></a>}

      <button className="btn ghost" style={{ marginTop: 12 }} onClick={onBack}>{['completed', 'cancelled'].includes(o.status) ? 'Back to menu' : 'View menu'}</button>
      {['completed', 'cancelled'].includes(o.status) && <button className="btn ghost" style={{ marginTop: 8 }} onClick={onForget}>Start a new order</button>}
    </div>
  )
}
