import { useState } from 'react';
import { buildSaleLines } from './engine/saleEngine';
import { calculateOrderTotals } from './engine/orderEngine';
import type { Ingredient, MenuItem } from './types';
const ingredient: Ingredient = { id: 'tea', name: 'Tea leaves', category: 'Dry goods', unit: 'g', currentStock: 1000, openingStock: 1000, costPerUnit: 1, minReorderThreshold: 100, criticalThreshold: 40, supplierId: 'demo' };
const menu: MenuItem = { id: 'cup', name: 'Tea', categoryId: 'drinks', categoryName: 'Drinks', description: 'Synthetic sample', basePrice: 40, isAvailable: true, recipe: [{ ingredientId: 'tea', ingredientName: 'Tea leaves', quantity: 5, unit: 'g', estimatedCost: 5 }], variations: [], modifiers: [], iconEmoji: '☕' };
type Sale = {
    id: string;
    time: string;
    quantity: number;
    total: number;
    netRevenue: number;
    tax: number;
};
type Store = {
    stock: number;
    sales: Sale[];
};
const key = 'oddflock-restosip-public-v1';
function read(): Store { try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && Number.isFinite(v.stock) && v.stock >= 0 && Array.isArray(v.sales) && v.sales.length <= 500 && v.sales.every((s: Sale) => typeof s.id === 'string' && typeof s.time === 'string' && ['quantity', 'total', 'netRevenue', 'tax'].every(k => Number.isFinite(s[k as keyof Sale]) && Number(s[k as keyof Sale]) >= 0)))
        return v;
}
catch { } return { stock: 1000, sales: [] }; }
export default function App() {
    const [store, setStore] = useState(read), [quantity, setQuantity] = useState(1), [received, setReceived] = useState(100), [tax, setTax] = useState(0), [error, setError] = useState('');
    const save = (next: Store) => { try {
        localStorage.setItem(key, JSON.stringify(next));
        setStore(next);
        setError('');
    }
    catch {
        setError('Browser storage is unavailable. Changes were not saved.');
    } };
    const sell = () => { if (store.sales.length >= 500) {
        setError('Demo limit reached: export and reset.');
        return;
    } if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
        setError('Tax must be between 0 and 100%.');
        return;
    } const built = buildSaleLines({ lines: [{ menuItemId: 'cup', quantity }], menuItems: [menu], ingredientsMap: new Map([['tea', { ...ingredient, currentStock: store.stock }]]) }); if (!built.ok) {
        setError(built.error);
        return;
    } const need = built.deductionNeeds.reduce((n, i) => n + i.quantity, 0); if (need > store.stock) {
        setError('Not enough tea leaves. Receive stock first.');
        return;
    } const totals = calculateOrderTotals({ items: built.items, discount: 0, taxRatePercent: tax }); save({ stock: store.stock - need, sales: [{ id: crypto.randomUUID(), time: new Date().toISOString(), quantity, total: totals.total, netRevenue: totals.netRevenue, tax: totals.tax }, ...store.sales] }); };
    const replenish = () => { if (!Number.isFinite(received) || received <= 0 || received > 100000) {
        setError('Receive a positive quantity up to 100,000 g.');
        return;
    } save({ ...store, stock: store.stock + received }); };
    const download = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ demo: true, ...store }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'restosip-public-demo.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    return <><header><small>ODDFLOCK · LIMITED PUBLIC EDITION</small><h1>RestoSIP Sales & Stock</h1><p>A small working till with real sale validation and money calculations. Synthetic data only.</p></header><main className="stack"><div className="row"><section className="card"><small>Tea leaves remaining</small><div className="metric">{store.stock} g</div></section><section className="card"><small>Recorded demo sales</small><div className="metric">{store.sales.length}</div></section><section className="card"><small>Revenue excluding tax</small><div className="metric">৳{store.sales.reduce((n, s) => n + s.netRevenue, 0).toFixed(2)}</div></section></div><div className="grid"><section className="card stack"><h2>Record a tea sale</h2><p>৳40 / cup · 5 g tea / cup · sample cost ৳5 / cup</p><label>Cups<input type="number" min={1} step={1} value={quantity} onChange={e => setQuantity(e.target.valueAsNumber)}/></label><label>Demo tax rate (%)<input type="number" min={0} max={100} value={tax} onChange={e => setTax(e.target.valueAsNumber)}/></label><button onClick={sell}>Record paid sale</button><h2>Receive stock</h2><label>Tea leaves (g)<input type="number" min={1} value={received} onChange={e => setReceived(e.target.valueAsNumber)}/></label><button onClick={replenish}>Add stock</button>{error && <p role="alert" className="error">{error}</p>}</section><section className="card"><h2>Sales history</h2><div className="table-wrap"><table><thead><tr><th>Time</th><th>Cups</th><th>Total</th><th>Tax</th></tr></thead><tbody>{store.sales.map(s => <tr key={s.id}><td>{new Date(s.time).toLocaleString()}</td><td>{s.quantity}</td><td>৳{s.total.toFixed(2)}</td><td>৳{s.tax.toFixed(2)}</td></tr>)}</tbody></table></div>{!store.sales.length && <p>No sales yet. Record one using the sample till.</p>}<div className="row"><button onClick={download}>Export demo JSON</button><button onClick={() => { if (confirm('Clear all demo sales and restore sample stock?'))
        save({ stock: 1000, sales: [] }); }}>Reset demo</button></div><p>Saved only in this browser under a separate demo key. No real payments, staff accounts, full ledger, refund system, cloud AI or desktop licensing is included. Do not use this demonstration as a production accounting system.</p></section></div></main></>;
}
