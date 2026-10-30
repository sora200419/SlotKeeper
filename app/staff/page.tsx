import '@bryntum/scheduler/fontawesome/css/fontawesome.css';
import '@bryntum/scheduler/fontawesome/css/solid.css';
import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/svalbard-light.css';
import './board.css';
import { StaffBoard } from '@/components/StaffBoard';

export const metadata = { title: 'Staff board · SlotKeeper' };

/** The owner's day: bookings coloured by deposit state, live from PayPal, and the copilot. */
export default function StaffPage() {
  return <StaffBoard />;
}
