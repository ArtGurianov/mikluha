import { CtaSection } from "@/components/home/cta-section";
import { Hero } from "@/components/home/hero";
import { OrganizerSection } from "@/components/home/organizer-section";
import { ReportsSection } from "@/components/home/reports-section";
import { ReviewsSection } from "@/components/home/reviews-section";
import { ToursSection } from "@/components/home/tours-section";
import { getContent } from "@/lib/cms/content";
import { getAllReviewsSorted, getListedTours, getTodayInTimezone, getUpcomingDepartures } from "@/lib/tours";

export default function HomePage() {
  const content = getContent();
  const today = getTodayInTimezone(content.siteSettings.timezone);

  return (
    <>
      <Hero siteSettings={content.siteSettings} />
      {/* Client-side filtering, so it gets only the two slices it needs rather than the whole snapshot. */}
      <ToursSection upcoming={getUpcomingDepartures(content, today)} tours={getListedTours(content)} />
      <ReportsSection content={content} />
      <OrganizerSection organizers={content.organizers} />
      <ReviewsSection reviews={getAllReviewsSorted(content)} />
      <CtaSection />
    </>
  );
}
