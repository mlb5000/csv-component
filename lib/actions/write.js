const axios = require('axios');
const csv = require('csv');
const _ = require('lodash');
const { messages } = require('elasticio-node');
const client = require('elasticio-rest-node')();
const logger = require('@elastic.io/component-logger')();
const uuidv4 = require('uuid/v4');

const util = require('../util/util');

const REQUEST_TIMEOUT = process.env.REQUEST_TIMEOUT || 10000; // 10s
const REQUEST_MAX_RETRY = process.env.REQUEST_MAX_RETRY || 7;
const REQUEST_RETRY_DELAY = process.env.REQUEST_RETRY_DELAY || 7000; // 7s
const REQUEST_MAX_CONTENT_LENGTH = process.env.REQUEST_MAX_CONTENT_LENGTH || 10485760; // 10MB
const TIMEOUT_BETWEEN_EVENTS = process.env.TIMEOUT_BETWEEN_EVENTS || 10000; // 10s;
// eslint-disable-next-line max-len
const ATTACHMENT_STORAGE_SERVICE_BASE_URL = process.env.ELASTICIO_ATTACHMENT_STORAGE_SERVICE_BASE_URL;
const API_KEY = process.env.ELASTICIO_API_KEY;

let stringifier;
let signedUrl;
let timeout;
let rowCount = 0;
let ax;
let putUrl;

let readyFlag = false;

async function init(cfg) {
  console.log(`ATTACHMENT_STORAGE_SERVICE_BASE_URL: ${ATTACHMENT_STORAGE_SERVICE_BASE_URL}, API_KEY: ${API_KEY}`);

  const delimiter = cfg.writer.separator || ',';
  const header = cfg.includeHeaders !== 'No';
  logger.trace('Using delimiter: \'%s\'', delimiter);
  const options = {
    header,
    delimiter,
  };

  if (cfg.writer.columns) {
    const columns = Object.keys(_.keyBy(cfg.writer.columns, 'property'));

    logger.trace('Configured column names:', columns);
    options.columns = columns;
  }

  stringifier = csv.stringify(options);

  if (ATTACHMENT_STORAGE_SERVICE_BASE_URL) {
    putUrl = `${ATTACHMENT_STORAGE_SERVICE_BASE_URL}/objects/${uuidv4()}`;
    signedUrl = {
      get_url: putUrl,
    };
  } else {
    signedUrl = await client.resources.storage.createSignedUrl();
    putUrl = signedUrl.put_url;
  }

  logger.trace('CSV file to be uploaded file to uri=%s', putUrl);
  ax = axios.create();
  util.addRetryCountInterceptorToAxios(ax);
  readyFlag = true;
}

async function ProcessAction(msg, cfg) {
  console.log(`Input: ${JSON.stringify(msg)}, Cfg: ${JSON.stringify(cfg)}`);
  
  // eslint-disable-next-line consistent-this
  const self = this;

  if (signedUrl === null) {
    init(cfg);
  }

  while (!readyFlag) {
    // eslint-disable-next-line no-loop-func,no-await-in-loop
    await new Promise(resolve => timeout(resolve, 100));
  }

  if (timeout) {
    clearTimeout(timeout);
  }

  timeout = setTimeout(async () => {
    readyFlag = false;

    self.logger.info('Closing the stream due to inactivity');

    const finalRowCount = rowCount;
    self.logger.info('The resulting CSV file contains %s rows', finalRowCount);
    const headers = {
      'content-type': 'text/csv',
    };
    if (ATTACHMENT_STORAGE_SERVICE_BASE_URL && API_KEY) {
      headers.authorization = `Bearer ${API_KEY}`;
    }

    ax.put(putUrl, stringifier, {
      method: 'PUT',
      headers,
      timeout: REQUEST_TIMEOUT,
      retry: REQUEST_MAX_RETRY,
      delay: REQUEST_RETRY_DELAY,
      maxContentLength: REQUEST_MAX_CONTENT_LENGTH,
    });
    stringifier.end();

    const messageToEmit = messages.newMessageWithBody({
      rowCount: finalRowCount,
    });
    const fileName = `${messageToEmit.id}.csv`;
    messageToEmit.attachments[fileName] = {
      'content-type': 'text/csv',
      url: signedUrl.get_url,
    };
    signedUrl = null;
    rowCount = 0;
    self.logger.trace('Emitting message %j', messageToEmit);
    await self.emit('data', messageToEmit);
    readyFlag = false;
  }, TIMEOUT_BETWEEN_EVENTS);

  let row = msg.body.writer || msg.body;
  self.logger.trace(`Incoming data: ${JSON.stringify(row)}`);
  if (cfg.writer.columns) {
    const columns = Object.keys(_.keyBy(cfg.writer.columns, 'property'));
    row = _.pick(row, columns);
  }
  self.logger.trace(`Writing Row: ${JSON.stringify(row)}`);
  stringifier.write(row);
  rowCount += 1;

  await self.emit('end');
}

exports.process = ProcessAction;
exports.init = init;
