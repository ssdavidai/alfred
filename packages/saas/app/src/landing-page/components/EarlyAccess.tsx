import { useEffect, useRef, useState } from "react";
import { submitAccessRequest } from "wasp/client/operations";

export default function EarlyAccess() {
  const sectionRef = useRef<HTMLElement>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    whyNeedButler: "",
    urgency: "",
    budget: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.querySelectorAll(".reveal").forEach((el, i) => {
              setTimeout(() => el.classList.add("visible"), i * 200);
            });
          }
        });
      },
      { threshold: 0.2 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (modalOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [modalOpen]);

  function handleChange(
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await submitAccessRequest(formData);
      setSubmitted(true);
      setTimeout(() => {
        setModalOpen(false);
        setSubmitted(false);
        setFormData({
          name: "",
          email: "",
          whyNeedButler: "",
          urgency: "",
          budget: "",
        });
      }, 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-sm border border-[#B8976A]/30 bg-[#111111] px-4 py-3 font-sans text-base font-light text-[#F5F0E8] placeholder-[#8A8680] outline-none transition-colors focus:border-[#B8976A]";

  return (
    <>
      <section
        ref={sectionRef}
        className="bg-[#0A0A0A] px-6 py-32 lg:py-40"
      >
        <div className="mx-auto max-w-[640px] text-center">
          <p className="reveal font-mono text-sm font-light uppercase tracking-[0.45em] text-gold">
            EARLY ACCESS
          </p>

          <h2 className="reveal mt-8 font-serif text-4xl font-light leading-[1.3] text-cream md:text-5xl">
            Alfred Black is in private beta
          </h2>

          <p className="reveal mt-8 font-sans text-base font-light leading-relaxed text-[#8A8680]">
            We are working closely with a small group of design partners before
            general availability. If you would like to get early access to
            Alfred, drop your name in the top hat.
          </p>

          <div className="reveal mt-12">
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-sm border border-[#B8976A] bg-transparent px-8 py-3 font-mono text-sm font-light uppercase tracking-[0.35em] text-[#B8976A] transition-colors hover:bg-[#B8976A]/10"
            >
              Request Access
            </button>
          </div>
        </div>
      </section>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="relative w-full max-w-lg rounded-sm border border-[#B8976A]/40 bg-[#0A0A0A] p-8">
            <button
              onClick={() => setModalOpen(false)}
              className="absolute right-4 top-4 font-sans text-xl text-[#8A8680] transition-colors hover:text-[#F5F0E8]"
            >
              ✕
            </button>

            {submitted ? (
              <p className="py-16 text-center font-serif text-xl font-light text-cream">
                Thank you — we will be in touch soon.
              </p>
            ) : (
              <form onSubmit={handleSubmit}>
                <h3 className="font-serif text-2xl font-light text-cream">
                  Request Early Access
                </h3>

                <div className="mt-8 space-y-5">
                  <input
                    name="name"
                    type="text"
                    placeholder="Full name"
                    required
                    value={formData.name}
                    onChange={handleChange}
                    className={inputClass}
                  />

                  <input
                    name="email"
                    type="email"
                    placeholder="Email address"
                    required
                    value={formData.email}
                    onChange={handleChange}
                    className={inputClass}
                  />

                  <textarea
                    name="whyNeedButler"
                    placeholder="Why do you need a butler?"
                    required
                    rows={3}
                    value={formData.whyNeedButler}
                    onChange={handleChange}
                    className={inputClass + " resize-none"}
                  />

                  <select
                    name="urgency"
                    required
                    value={formData.urgency}
                    onChange={handleChange}
                    className={inputClass + (!formData.urgency ? " text-[#8A8680]" : "")}
                  >
                    <option value="" disabled>
                      How urgent is this for you?
                    </option>
                    <option value="Just exploring">Just exploring</option>
                    <option value="Within the next month">
                      Within the next month
                    </option>
                    <option value="I need this now">I need this now</option>
                  </select>

                  <select
                    name="budget"
                    required
                    value={formData.budget}
                    onChange={handleChange}
                    className={inputClass + (!formData.budget ? " text-[#8A8680]" : "")}
                  >
                    <option value="" disabled>
                      What is your monthly budget?
                    </option>
                    <option value="I don't know yet">I don't know yet</option>
                    <option value="ChatGPT Pro territory ($20/mo)">ChatGPT Pro territory ($20/mo)</option>
                    <option value="Claude Max territory ($200/mo)">Claude Max territory ($200/mo)</option>
                    <option value="Clay territory ($500–$1,000/mo)">Clay territory ($500–$1,000/mo)</option>
                    <option value="Athena territory ($1,000+/mo)">Athena territory ($1,000+/mo)</option>
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="mt-8 w-full rounded-sm border border-[#B8976A] bg-[#B8976A] px-8 py-3 font-mono text-sm font-light uppercase tracking-[0.35em] text-[#0A0A0A] transition-colors hover:bg-[#B8976A]/90 disabled:opacity-50"
                >
                  {isSubmitting ? "Submitting..." : "Submit Request"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
