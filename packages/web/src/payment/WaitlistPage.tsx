import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Phone } from "lucide-react";
import { Button } from "../client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "../client/components/ui/card";
import { Input } from "../client/components/ui/input";
import { Label } from "../client/components/ui/label";

const WaitlistPage = () => {
  const [phone, setPhone] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.trim()) {
      localStorage.setItem(
        "alfred_waitlist",
        JSON.stringify({ phone: phone.trim(), timestamp: Date.now() }),
      );
      setSubmitted(true);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] px-6">
      <div className="w-full max-w-md">
        <div className="mb-12 text-center">
          <img
            src="/images/alfred-logo.png"
            alt="Alfred"
            className="mx-auto h-16 w-16"
          />
        </div>

        <Card>
          <CardHeader className="text-center">
            <p className="font-mono text-[0.62rem] font-light uppercase tracking-[0.45em] text-gold">
              CLOSED BETA
            </p>
            <h1 className="mt-4 font-serif text-2xl font-light text-cream">
              Thank you for your interest
            </h1>
          </CardHeader>
          <CardContent>
            {submitted ? (
              <div className="space-y-6 text-center">
                <p className="font-sans text-sm font-light leading-relaxed text-[#8A8680]">
                  You're on the list. I'll text you first before calling --
                  promise. Sit tight.
                </p>
                <div className="pt-2">
                  <Link
                    to="/"
                    className="font-mono text-[0.62rem] font-light uppercase tracking-[0.35em] text-gold transition-colors hover:text-cream"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArrowLeft className="h-3 w-3" />
                      BACK TO HOME
                    </span>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <p className="font-sans text-sm font-light leading-relaxed text-[#8A8680]">
                  I'm currently at capacity but I will reach out when a spot
                  opens up. Want me to give you a call when I become available?
                  Just leave your number below.
                </p>
                <p className="font-sans text-sm font-light italic leading-relaxed text-[#8A8680]">
                  Don't worry, I will text you first :)
                </p>

                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <Label className="font-mono text-xs font-light uppercase tracking-[0.35em] text-muted-foreground">
                      Phone number
                    </Label>
                    <div className="relative">
                      <Phone className="absolute left-0 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        type="tel"
                        placeholder="+1 (555) 000-0000"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="pl-6"
                      />
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={!phone.trim()}>
                    NOTIFY ME
                  </Button>
                </form>

                <div className="pt-2 text-center">
                  <Link
                    to="/"
                    className="font-mono text-[0.62rem] font-light uppercase tracking-[0.35em] text-muted-foreground transition-colors hover:text-gold"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArrowLeft className="h-3 w-3" />
                      BACK TO HOME
                    </span>
                  </Link>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default WaitlistPage;
