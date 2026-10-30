import { ReportView } from '@/components/ReportView';

export const metadata = { title: 'Deposits report · SlotKeeper' };

/** Staff report: captured deposits, no-show fees and refunds from PayPal Transaction Search. */
export default function ReportPage() {
  return (
    <main>
      <h1>Deposits report</h1>
      <ReportView />
    </main>
  );
}
