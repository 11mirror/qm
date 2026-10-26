import { test } from "node:test";
import assert from "node:assert/strict";
import { awsErrorCode } from "../src/aws-lease.ts";

test("awsErrorCode reads the AWS CLI's 'An error occurred (Code)' text", () => {
  const error = new Error(
    "aws secretsmanager get-secret-value failed:\nAn error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.",
  );
  assert.equal(awsErrorCode(error), "ResourceNotFoundException");
});

test("awsErrorCode reads a leading 'Code: message' line", () => {
  assert.equal(
    awsErrorCode(new Error("aws secretsmanager get-secret-value failed:\nResourceNotFoundException: can't find it")),
    "ResourceNotFoundException",
  );
  assert.equal(awsErrorCode("AccessDeniedException: not allowed"), "AccessDeniedException");
});

test("awsErrorCode reads an SDK-style error's name", () => {
  const error = Object.assign(new Error("lock held"), { name: "ConditionalCheckFailedException" });
  assert.equal(awsErrorCode(error), "ConditionalCheckFailedException");
});

test("awsErrorCode returns undefined for errors without an AWS code", () => {
  assert.equal(awsErrorCode(new Error("Error: connect ECONNREFUSED")), undefined);
  assert.equal(awsErrorCode(new Error("docker build failed")), undefined);
});
