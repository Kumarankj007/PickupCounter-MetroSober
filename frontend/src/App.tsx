import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest } from './api';
import { ProductCard } from './components/ProductCard';
import { formatCountdown, useCountdownTimer } from './hooks/useCountdownTimer';
import { useOrderPolling } from './hooks/useOrderPolling';
import type { Order, Product } from './types';

function money(paise: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [createdOrder, setCreatedOrder] = useState<Order | null>(null);
  const [holdSeconds, setHoldSeconds] = useState<number | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { order: polledOrder, setOrder: setPolledOrder, pollError } = useOrderPolling(createdOrder?.id ?? null);

  const refreshProducts = useCallback(async () => {
    try {
      const latest = await apiRequest<Product[]>('/products');
      setProducts(latest);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load products. Check that the API and PostgreSQL are running.');
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    void refreshProducts();
    const timer = window.setInterval(() => void refreshProducts(), 3000);
    return () => window.clearInterval(timer);
  }, [refreshProducts]);

  const currentOrder = polledOrder ?? createdOrder;
  const timerActive = currentOrder?.status === 'pending_payment';
  const secondsLeft = useCountdownTimer(holdSeconds, timerActive);
  const cartItems = useMemo(
    () => products.filter((product) => (cart[product.id] ?? 0) > 0),
    [cart, products],
  );
  const cartCount = cartItems.reduce((count, product) => count + (cart[product.id] ?? 0), 0);
  const cartTotal = cartItems.reduce((total, product) => total + product.pricePaise * (cart[product.id] ?? 0), 0);

  function changeQuantity(product: Product, delta: number) {
    setCart((previous) => {
      const current = previous[product.id] ?? 0;
      const next = Math.max(0, Math.min(product.availableUnits, current + delta));
      return { ...previous, [product.id]: next };
    });
    setNotice(null);
  }

  async function placeOrder() {
    if (cartCount === 0) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const body = cartItems.map((product) => ({ productId: product.id, quantity: cart[product.id] ?? 0 }));
      const created = await apiRequest<Order>('/orders', { method: 'POST', body: JSON.stringify(body) });
      setCreatedOrder(created);
      setPolledOrder(null);
      setHoldSeconds(created.expiresInSeconds);
      setCart({});
      await refreshProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not place order.');
      await refreshProducts();
    } finally {
      setSubmitting(false);
    }
  }

  async function claimPickup() {
    if (!currentOrder) return;
    setClaiming(true);
    setError(null);
    try {
      const result = await apiRequest<{ id: string; status: 'claimed'; claimedAt: string; message: string }>(
        `/orders/${currentOrder.id}/pickup-claim`, { method: 'POST' },
      );
      setPolledOrder({ ...currentOrder, status: result.status, claimedAt: result.claimedAt, message: result.message });
      setCreatedOrder({ ...currentOrder, status: result.status, claimedAt: result.claimedAt, message: result.message });
      setNotice('Pickup confirmed. The inventory has been updated.');
      await refreshProducts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pickup claim failed.');
      try {
        const latest = await apiRequest<Order>(`/orders/${currentOrder.id}`);
        setPolledOrder(latest);
      } catch { /* the original error is more useful */ }
    } finally {
      setClaiming(false);
    }
  }

  async function copyWebhookCommand() {
    if (!currentOrder) return;
    const command = `npm run send-webhook -- --orderId ${currentOrder.id} --amount ${currentOrder.totalPaise} --eventId evt_${currentOrder.id.slice(0, 8)}`;
    try {
      await navigator.clipboard.writeText(command);
      setNotice('Webhook command copied. Run it from the project directory to simulate a successful payment.');
    } catch {
      setNotice(command);
    }
  }

  function startNewOrder() {
    setCreatedOrder(null);
    setPolledOrder(null);
    setHoldSeconds(null);
    setNotice(null);
    setError(null);
    void refreshProducts();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#top" className="brand" aria-label="Pickup Counter home"><span className="brand-mark">P</span><span>pickup<span className="brand-light">counter</span></span></a>
        <div className="topbar-right"><span className="status-dot" /> Demo counter <span className="topbar-divider" /> <span className="small-muted">Payment simulation</span></div>
      </header>

      <main id="top" className="page-content">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">QUICK · SIMPLE · SELF-SERVICE</p>
            <h1>A little treat,<br /><span>without the wait.</span></h1>
            <p className="hero-description">Pick your snacks, complete the simulated UPI payment, and collect your order from the locker.</p>
            <div className="hero-meta"><span><span className="meta-icon">◷</span> 2-minute reservation</span><span><span className="meta-icon">▣</span> Locker pickup</span></div>
          </div>
          <div className="hero-art" aria-hidden="true"><div className="art-circle art-circle-large" /><div className="art-circle art-circle-small" /><div className="snack-bag"><span>GOOD<br />SNACKS</span><b>✳</b></div><div className="floating-snack snack-one">🥨</div><div className="floating-snack snack-two">🍫</div><div className="floating-snack snack-three">🥜</div></div>
        </section>

        {error && <div className="alert alert-error" role="alert"><strong>Something needs attention.</strong><span>{error}</span><button className="alert-dismiss" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
        {notice && <div className="alert alert-success" role="status"><span>{notice}</span><button className="alert-dismiss" onClick={() => setNotice(null)} aria-label="Dismiss message">×</button></div>}

        <div className="section-heading">
          <div><p className="eyebrow">THE COUNTER MENU</p><h2>Find your favourite.</h2></div>
          <div className="menu-note"><span className="live-dot" /> Stock updates automatically</div>
        </div>

        <div className="main-grid">
          <section className="catalog-section" aria-label="Snack catalog">
            {loadingProducts ? <div className="loading-panel">Loading the snack counter…</div> : products.length === 0 ? <div className="loading-panel">No products found. Run the database setup command.</div> : (
              <div className="product-grid">
                {products.map((product) => <ProductCard key={product.id} product={product} quantity={cart[product.id] ?? 0} onAdd={() => changeQuantity(product, 1)} onRemove={() => changeQuantity(product, -1)} />)}
              </div>
            )}
            <p className="catalog-footnote">Prices are in Indian rupees. Inventory is checked again by the server at checkout.</p>
          </section>

          <aside className="checkout-card" aria-label="Cart and checkout">
            <div className="checkout-header"><div><p className="eyebrow">YOUR SELECTION</p><h2>Your snack bag <span className="count-pill">{cartCount}</span></h2></div><span className="bag-icon">▱</span></div>
            {!currentOrder ? <>
              {cartItems.length === 0 ? <div className="empty-cart"><div className="empty-cart-icon">＋</div><strong>Your bag is waiting.</strong><p>Add something delicious from the menu.</p></div> : <div className="cart-list">{cartItems.map((product) => <div className="cart-line" key={product.id}><div><strong>{product.name}</strong><span>{money(product.pricePaise)} each</span></div><div className="cart-line-right"><span>× {cart[product.id]}</span><strong>{money(product.pricePaise * (cart[product.id] ?? 0))}</strong></div></div>)}</div>}
              <div className="cart-total"><span>Total</span><strong>{money(cartTotal)}</strong></div>
              <button className="button button-primary checkout-button" disabled={cartCount === 0 || submitting} onClick={() => void placeOrder()}>{submitting ? 'Reserving stock…' : 'Reserve & continue'} <span>→</span></button>
              <p className="fine-print">Your items are held for 120 seconds after checkout.</p>
            </> : <OrderPanel order={currentOrder} secondsLeft={secondsLeft} pollError={pollError} onClaim={() => void claimPickup()} claiming={claiming} onNewOrder={startNewOrder} onCopyWebhook={() => void copyWebhookCommand()} />}
          </aside>
        </div>

        <section className="how-section">
          <div><span className="how-number">01</span><div><strong>Choose your snacks</strong><p>Add your favourites to the bag.</p></div></div>
          <div><span className="how-number">02</span><div><strong>Pay within 2 minutes</strong><p>A demo webhook simulates capture.</p></div></div>
          <div><span className="how-number">03</span><div><strong>Collect from a locker</strong><p>Only one claim can succeed.</p></div></div>
        </section>
      </main>
      <footer className="footer"><span>pickupcounter © 2026</span><span>Built for reliable pickup, even when requests race.</span></footer>
    </div>
  );
}

function OrderPanel({ order, secondsLeft, pollError, onClaim, claiming, onNewOrder, onCopyWebhook }: {
  order: Order; secondsLeft: number; pollError: string | null; onClaim: () => void; claiming: boolean; onNewOrder: () => void; onCopyWebhook: () => void;
}) {
  return (
    <div className="order-panel">
      <div className="order-ref"><span>ORDER REFERENCE</span><strong>{order.id.slice(0, 8).toUpperCase()}</strong></div>
      <div className="order-lines">{order.items.map((item) => <div className="order-line" key={item.productId}><span>{item.quantity} × {item.name}</span><strong>{money(item.unitPricePaise * item.quantity)}</strong></div>)}</div>
      <div className="cart-total"><span>Order total</span><strong>{money(order.totalPaise)}</strong></div>
      {pollError && <p className="poll-warning">Status refresh failed: {pollError}. Retrying automatically.</p>}
      {order.status === 'pending_payment' && <>
        <div className={secondsLeft <= 15 ? 'timer-box timer-warning' : 'timer-box'}><span>TIME LEFT TO PAY</span><strong>{formatCountdown(secondsLeft)}</strong><p>Your stock reservation expires when the timer reaches zero.</p></div>
        <div className="payment-instructions"><div className="payment-mark">UPI</div><div><strong>Simulated UPI payment</strong><p>No real money is charged in this demo.</p></div></div>
        <button className="button button-primary full-button" onClick={onCopyWebhook}>Get signed payment simulation command ↗</button>
        <p className="fine-print">Run the command in your terminal. This sends the signed webhook just as a provider would.</p>
      </>}
      {order.status === 'paid' && <div className="state-panel state-paid"><span className="state-icon">✓</span><div><strong>Payment confirmed</strong><p>Your order is ready. Claim it when you reach the locker.</p></div><button className="button button-primary full-button" onClick={onClaim} disabled={claiming}>{claiming ? 'Claiming…' : 'Claim from locker →'}</button></div>}
      {order.status === 'expired' && <div className="state-panel state-expired"><span className="state-icon">⌛</span><div><strong>Reservation expired</strong><p>The 120-second hold ended before payment was confirmed. Your items are available for other customers again.</p></div><button className="button button-primary full-button" onClick={onNewOrder}>Reload catalog</button></div>}
      {order.status === 'needs_review' && <div className="state-panel state-review"><span className="state-icon">!</span><div><strong>Payment needs review</strong><p>We could not safely match this capture to available stock or the expected amount. Please contact counter staff; do not retry payment yet.</p></div><button className="button button-light full-button" onClick={onNewOrder}>Back to catalog</button></div>}
      {order.status === 'claimed' && <div className="state-panel state-paid"><span className="state-icon">✓</span><div><strong>Pickup confirmed</strong><p>This order has been claimed. Thanks for stopping by!</p></div><button className="button button-primary full-button" onClick={onNewOrder}>Start a new order</button></div>}
    </div>
  );
}
