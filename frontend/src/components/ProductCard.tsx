import type { Product } from '../types';

function money(paise: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

interface Props {
  product: Product;
  quantity: number;
  onAdd: () => void;
  onRemove: () => void;
}

export function ProductCard({ product, quantity, onAdd, onRemove }: Props) {
  const soldOut = product.availableUnits <= 0;
  return (
    <article className="product-card">
      <div className="product-symbol" aria-hidden="true">{product.name.includes('Water') ? '💧' : product.name.includes('Chocolate') ? '🍫' : product.name.includes('Chips') ? '🥔' : product.name.includes('Granola') ? '🌾' : '🥜'}</div>
      <div className="product-title-row">
        <h3>{product.name}</h3>
        <span className="price">{money(product.pricePaise)}</span>
      </div>
      <p className={soldOut ? 'stock stock-empty' : 'stock'}>{soldOut ? 'Out of stock' : `${product.availableUnits} available`}</p>
      <div className="quantity-controls">
        <button className="button button-light button-square" onClick={onRemove} disabled={quantity === 0} aria-label={`Remove one ${product.name}`}>−</button>
        <span className="quantity" aria-live="polite">{quantity}</span>
        <button className="button button-dark button-square" onClick={onAdd} disabled={soldOut || quantity >= product.availableUnits} aria-label={`Add one ${product.name}`}>+</button>
      </div>
    </article>
  );
}
