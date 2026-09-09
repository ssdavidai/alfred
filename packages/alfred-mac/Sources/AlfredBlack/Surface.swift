// The kit's components, as SwiftUI: a mono status chip, one sparse ledger
// line, the terminal prompt that is the hero of every Alfred surface, and
// the reply in Alfred's own voice — serif, signed.
import SwiftUI

/// Mono uppercase status chip. Brass is filled (the one accent); the others are quiet outlines.
struct Pill: View {
  enum Tone { case brass, outline, muted, success, destructive }
  let text: String; var tone: Tone = .outline
  var body: some View {
    Text(text.uppercased()).font(AB.mono(9, weight: .bold)).tracking(1.4)
      .padding(.horizontal, 7).padding(.vertical, 3)
      .foregroundColor(tone == .brass ? AB.paper : tone == .success ? AB.billiard : tone == .destructive ? AB.oxblood : tone == .muted ? AB.marginalia : AB.ink)
      .background(tone == .brass ? AB.brass : Color.clear)
      .overlay(Rectangle().stroke(tone == .muted ? Color.clear : tone == .brass ? AB.brass : tone == .success ? AB.billiard : tone == .destructive ? AB.oxblood : AB.rule, lineWidth: 1))
  }
}

/// One line of a ledger: time · subject · state · next action, and nothing else.
/// Divided by a hairline; washes 6% brass on hover and its rule brasses.
struct LedgerRow<State: View>: View {
  let time: String; let subject: String; var state: State; var action: (() -> Void)? = nil
  @SwiftUI.State private var hover = false
  var body: some View {
    VStack(spacing: 0) {
      Button(action: { action?() }) {
        HStack(spacing: 12) {
          Text(time).font(AB.mono(10)).foregroundColor(AB.marginalia).frame(width: 54, alignment: .leading)
          Text(subject).font(AB.body(15)).foregroundColor(AB.ink).lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 8)
          state
        }.padding(.vertical, 8).padding(.horizontal, 6).contentShape(Rectangle())
      }.buttonStyle(.plain).background(hover ? AB.brass.opacity(0.06) : Color.clear)
      Rectangle().fill(hover ? AB.brass.opacity(0.7) : AB.rule).frame(height: 1)
    }
    .onHover { hover = $0 }
    .animation(.easeOut(duration: 0.16), value: hover)
  }
}

/// The terminal prompt — brass `alfred.black >`, a calm placeholder, mono throughout, a hairline frame.
struct CommandField: View {
  @Binding var text: String; var busy: Bool; var onSubmit: () -> Void
  @FocusState private var focused: Bool
  var body: some View {
    HStack(spacing: 10) {
      Text("alfred.black >").font(AB.mono(12, weight: .bold)).foregroundColor(AB.brass)
      TextField("What shall Alfred handle?", text: $text).textFieldStyle(.plain).font(AB.mono(13)).foregroundColor(AB.ink)
        .focused($focused).onSubmit(onSubmit).disabled(busy)
      if busy { Text("…").font(AB.mono(12)).foregroundColor(AB.marginalia) }
    }
    .padding(.horizontal, 12).padding(.vertical, 10)
    .overlay(Rectangle().stroke(focused ? AB.brass : AB.border, lineWidth: 1))
    .animation(.easeOut(duration: 0.16), value: focused)
  }
}

/// What Alfred says: serif, full sentences, signed.
struct ReplyView: View {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(text).font(AB.body(16)).foregroundColor(AB.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      Text("— Alfred.").font(AB.body(15, italic: true)).foregroundColor(AB.marginalia)
    }
  }
}
