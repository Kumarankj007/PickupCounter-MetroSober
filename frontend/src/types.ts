export type OrderStatus = 'pending_payment' | 'paid' | 'expired' | 'needs_review' | 'claimed';

export interface Product {
  id: string;
  name: string;
  pricePaise: number;
  stock: number;
  availableUnits: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  expiresAt: string;
  expiresInSeconds: number;
  items: OrderItem[];
  claimedAt?: string;
  message?: string;
}
