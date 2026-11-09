import { createRoot } from 'react-dom/client'
import App from './App'
import Admin from './Admin'
import './styles.css'
const isAdmin = location.pathname.startsWith('/admin')
createRoot(document.getElementById('root')).render(isAdmin ? <Admin /> : <App />)
