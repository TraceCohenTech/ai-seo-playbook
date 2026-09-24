'use client';
import { useState } from 'react';
export default function Calculator() {
  const [seats, setSeats] = useState(10);
  return <section><h1>Acme Pricing Calculator</h1><input value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></section>;
}
