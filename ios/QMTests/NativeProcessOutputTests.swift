import XCTest

@testable import QM

final class NativeProcessOutputTests: XCTestCase {
  func testProcessOutputRetainsEveryPageAndDrainsAfterExit() {
    var transcript = NativeProcessTranscript()
    let first = String(repeating: "a", count: 200_000)
    XCTAssertTrue(
      transcript.apply(.init(chunk: first, cursor: 200_000, state: "running", exitCode: nil)))
    XCTAssertTrue(
      transcript.apply(.init(chunk: "tail", cursor: 200_004, state: "exited", exitCode: 0)))
    XCTAssertFalse(
      transcript.apply(.init(chunk: "", cursor: 200_004, state: "exited", exitCode: 0)))
    XCTAssertEqual(transcript.output, first + "tail")
    XCTAssertEqual(transcript.exitCode, 0)
  }
}
