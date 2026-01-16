import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    endpoint: process.env.AWS_ENDPOINT_URL!,
    region: process.env.AWS_REGION!
}), {
    marshallOptions: {
        removeUndefinedValues: true,
    },
});

export const USERS_TABLE = process.env.USERS_TABLE!;