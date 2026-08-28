/**
 * GA4 Conversion Event Tracking
 *
 * Drop-in analytics helpers for the three events every content site
 * should track. Without these, GA4 only records automatic events
 * (page_view, scroll, etc.) — which bots trigger too, making your
 * data useless for real decisions.
 *
 * After deploying this code, you MUST also:
 *   1. Go to GA4 Admin → Events
 *   2. Find each custom event
 *   3. Toggle "Mark as key event"
 *
 * GA4 won't count them as conversions until you flip that switch.
 * Shipping the code is only half the job.
 *
 * Usage:
 *   import { trackNewsletterSignup, trackToolComplete, trackAffiliateClick } from '@/lib/analytics';
 */

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag(...args);
  }
}

/**
 * Track newsletter signups across all subscribe forms.
 * Tag each form location so you know which placement converts best.
 */
export function trackNewsletterSignup(
  source: 'homepage_hero' | 'blog_sidebar' | 'footer' | 'popup' | 'inline_cta' | string
) {
  gtag('event', 'newsletter_signup', { source });
}

/**
 * Track tool/calculator completions.
 * Users who complete an interactive tool are your highest-intent visitors.
 */
export function trackToolComplete(
  toolName: string,
  result?: string | number
) {
  gtag('event', 'tool_complete', {
    tool_name: toolName,
    ...(result !== undefined && { result: String(result) }),
  });
}

/**
 * Track affiliate/CTA clicks with position tagging.
 * Position matters: hero CTAs convert 3-5x more than footer CTAs.
 * If you don't tag position, you can't measure this.
 */
export function trackAffiliateClick(
  destination: string,
  position: 'hero' | 'mid' | 'footer' | 'sidebar' | string
) {
  gtag('event', 'affiliate_click', {
    destination,
    position,
  });
}
