// Minimal types for the PayPal JS SDK v6 surface this app uses (see /sdk/js/reference).
export {};

declare global {
  interface PayPalOneTimePaymentSession {
    start(
      options: { presentationMode?: 'auto' | 'popup' | 'modal' | 'redirect' },
      orderPromise: Promise<{ orderId: string }>,
    ): Promise<void>;
    hasReturned(): boolean;
    resume(): Promise<void>;
  }

  interface PayPalSdkInstance {
    findEligibleMethods(options?: { currencyCode?: string; amount?: string }): Promise<{
      isEligible(method: string): boolean;
    }>;
    createPayPalOneTimePaymentSession(options: {
      onApprove: (data: { orderId: string; payerId?: string }) => Promise<void> | void;
      onCancel?: (data: { orderId?: string }) => void;
      onError?: (error: { code?: string; message?: string }) => void;
    }): PayPalOneTimePaymentSession;
  }

  interface Window {
    paypal?: {
      createInstance(options: {
        clientId: string;
        components: string[];
        pageType?: string;
      }): Promise<PayPalSdkInstance>;
    };
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        type?: 'pay' | 'checkout' | 'buynow' | 'subscribe';
        class?: string;
      };
    }
  }
}
