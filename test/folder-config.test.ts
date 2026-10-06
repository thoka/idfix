import { describe, expect, test } from "bun:test";
import { FOLDER_CONFIG, readSessionNames, sessionNamesSource } from "../src/folder-config";

const FOLDER = "/home/user/src";
const FILE = `${FOLDER}/${FOLDER_CONFIG}`;

/** A readText with one file. */
const withFile = (text: string | null) => (file: string) => (file === FILE ? text : null);

describe("readSessionNames", () => {
  test("no file gives an empty list without a problem", () => {
    expect(readSessionNames(FOLDER, withFile(null))).toEqual({ names: [] });
  });

  test("a file without the key gives an empty list, and unknown keys are ignored", () => {
    expect(readSessionNames(FOLDER, withFile('other = "x"\n'))).toEqual({ names: [] });
  });

  test("a list of names", () => {
    const text = 'session_names = ["lead", "reviewer"]\nlater = 1\n';
    expect(readSessionNames(FOLDER, withFile(text))).toEqual({ names: ["lead", "reviewer"] });
  });

  test("a bad TOML gives an empty list and a problem", () => {
    const result = readSessionNames(FOLDER, withFile("session_names = [\"lead\"\n"));
    expect(result.names).toEqual([]);
    expect(result.problem).toStartWith(`bad ${FILE}: `);
  });

  test("a value that is not an array gives an empty list and a problem", () => {
    expect(readSessionNames(FOLDER, withFile('session_names = "lead"\n'))).toEqual({
      names: [],
      problem: `bad ${FILE}: session_names is not an array of non-empty strings`,
    });
  });

  test("an array with a non-string or an empty string gives an empty list and a problem", () => {
    for (const value of ['["lead", 3]', '["lead", ""]', '["  "]']) {
      expect(readSessionNames(FOLDER, withFile(`session_names = ${value}\n`))).toEqual({
        names: [],
        problem: `bad ${FILE}: session_names is not an array of non-empty strings`,
      });
    }
  });
});

describe("sessionNamesSource", () => {
  test("a reader reads each folder at most once per tick", () => {
    const reads: string[] = [];
    const source = sessionNamesSource((file) => {
      reads.push(file);
      return file === FILE ? 'session_names = ["lead"]\n' : null;
    });
    const first = source.forTick();
    expect(first(FOLDER)).toEqual(["lead"]);
    expect(first(FOLDER)).toEqual(["lead"]);
    expect(first("/home/user/other")).toEqual([]);
    expect(reads).toEqual([FILE, "/home/user/other/.idfix.toml"]);
    const second = source.forTick();
    expect(second(FOLDER)).toEqual(["lead"]);
    expect(reads).toEqual([FILE, "/home/user/other/.idfix.toml", FILE]);
  });

  test("each problem goes to report once per folder and problem text", () => {
    const err: string[] = [];
    let text = 'session_names = "lead"\n';
    const source = sessionNamesSource(
      (file) => (file.endsWith(FOLDER_CONFIG) ? text : null),
      (line) => err.push(line),
    );
    source.forTick()(FOLDER);
    source.forTick()(FOLDER);
    expect(err).toEqual([`bad ${FILE}: session_names is not an array of non-empty strings`]);
    // The same problem in another folder is reported for that folder.
    source.forTick()("/home/user/other");
    expect(err).toHaveLength(2);
    // A new problem text in the same folder is reported once more.
    text = "session_names = [\n";
    source.forTick()(FOLDER);
    source.forTick()(FOLDER);
    expect(err).toHaveLength(3);
    expect(err[2]).toStartWith(`bad ${FILE}: `);
  });
});
