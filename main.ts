/*
(c) Copyright 2023 Akamai Technologies, Inc. Licensed under Apache 2 license.
Purpose: Moving age-gate logic to the Akamai edge using EdgeKV.
*/
import { logger } from "log";
import { createResponse } from 'create-response';
import { EdgeKV } from "./edgekv.js";
import { SetCookie } from "cookies";

/* 
A "cold-key" edgeKV lookup might take too long so just retry it x times.
Our namespace is in US, try to use the most optimal location EU or Asia for your customers.
We're also setting a global timeout (1-1000).
https://techdocs.akamai.com/edgekv/docs/library-helper-methods#constructor
*/
const edgeKv2fa = new EdgeKV({namespace: "jgrinwiskv",  group: "age_gate", num_retries_on_timeout:2});
const edgeKvTimeout = 500

export async function responseProvider (request: EW.ResponseProviderRequest) {

    // our default response header
    let responseHeader = { 'Powered-By': ['Akamai EdgeWorkers: 0.0.16'], 'content-type': ['application/json'] }
    let jsonBody: Promise<object>

    // use interface to define the structure of our Response object
    interface Response {
        age: number;
        country: string;
        message: string;
    }

    /*
    lets convert the body to json and wait for the promise to get fullfilled
    The maximum request size when using non streaming is 16 KB so we should be aware of that.
    If it's > 16KB or doesn't contain json the promise will be rejected so we need to catch that.
    */
    try {
        jsonBody = await request.json()
    } catch (error) {
        /*
        we can reject the promise but then you will get an "akamai error code"
        return Promise.reject('wrong request body')

        So just resolving the promise with the catched error message
        */
        const errorMessage = `{\"error\": \"${error}\"}`
        return Promise.resolve(createResponse(503, responseHeader, errorMessage))
    }
   
    // use the userlocation object from the request to get the country code (ISO-3166) this request is coming from
    // the birthday json object should have a ISO 8601 format, YYYY-MM-DD
    const countryCode: string = request.userLocation.country || 'NL'
    const birthdate: Date = new Date(jsonBody['birthday'])
    const age: number = calculateAge(birthdate)

    // use some default value in case lookup goes wrong
    let minimalAge: number = 18

    // our default json response message
    let response: Response = {
        age: age,
        country: countryCode,
        message: 'You are too young to drink!'
    };
    /*
    lookup the minimal age for a country in EdgeKV, a distribute key value store.
    This is a very simple datastructure so we could use a local object but just to show EdgeKV as an example

    Make sure your access token is still valid: 'akamai edgekv list tokens' 
    if still valid, download a token via 'akamai edgekv download token --save_path=built/ <token>'.
    - You can write some individual items to EdgeKV via:
    'akamai edgekv write text staging|production  <namespace> <groupId> <key> <value>'
    - list all items:
    'akamai edgekv list items staging|production <namespace> <groupId>'
    - read item:
    `akamai edgekv read item sstaging|production <namespace> <groupId> <key>'
    */
    try {
        minimalAge = await edgeKv2fa.getJson({ item: countryCode, timeout: edgeKvTimeout })
        logger.log(`edgekv value: ${minimalAge}`)
    } catch (error) {
        logger.log("something went wrong: %s", error.toString)
    }
    
    if (age >= minimalAge) {
        // so this dude is old enough, let's set a cookie and update the message
        let cookie = new SetCookie();
        cookie.name = 'old_enough';
        cookie.value = 'yes';

        // set cookie in the header. use bracket as property is not known.
        responseHeader['set-cookie'] = cookie.toHeader()

        // update response message
        response.message = 'Welcome, have a drink.'
    }
    
    // it's time so say goodbye. Return our resolved promise
    return Promise.resolve(createResponse(200, responseHeader, JSON.stringify(response)))
}

function calculateAge(birthdate: Date): number {
    // some chatgpt generated code to calcute the age of a person, thank you chatgpt
    const now = new Date();
    const diff = now.getTime() - birthdate.getTime();

    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getUTCFullYear
    const ageInYears = new Date(diff).getUTCFullYear() - 1970;

    return ageInYears;
}