import Hero from "./components/Hero";
import Overwhelm from "./components/Overwhelm";
import KnowledgeGraph from "./components/KnowledgeGraph";
import WhatIsAlfred from "./components/WhatIsAlfred";
import LifeWithAlfred from "./components/LifeWithAlfred";
// import Pricing from "./components/Pricing";
import EarlyAccess from "./components/EarlyAccess";
import CTA from "./components/CTA";
import Footer from "./components/Footer";

export default function LandingPage() {
  return (
    <div>
      <Hero />
      <Overwhelm />
      <KnowledgeGraph />
      <WhatIsAlfred />
      <LifeWithAlfred />
      {/* <Pricing /> */}
      <EarlyAccess />
      <CTA />
      <Footer />
    </div>
  );
}
