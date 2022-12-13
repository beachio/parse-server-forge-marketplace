console.log('Cloud code connected');
const request = require('request');
const proxy = require('express-http-proxy');
const axios = require('axios');
const {config, SITE, ROLE_ADMIN, ROLE_EDITOR, promisifyW, getAllObjects} = require('./common');

const {getPayPlan} = require('./payment');


const checkRights = (user, obj) => {
  const acl = obj.getACL();
  if (!acl)
    return true;

  const read = acl.getReadAccess(user.id);
  const write = acl.getWriteAccess(user.id);

  const pRead = acl.getPublicReadAccess();
  const pWrite = acl.getPublicWriteAccess();

  return read && write || pRead && pWrite;
};


const getTableData = async (table) => {
  const endpoint = '/schemas/' + table;

  try {
    const response = await Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    });

    if (response.status == 200)
      return response.data;

  } catch (e) {}

  return null;
};

const setTableData = async (table, data, method = 'POST') => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method,
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    },
    body: JSON.stringify(data)
  });

  if (response.status != 200)
    throw response.status;
};

const deleteTable = async (table) => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method: 'DELETE',
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    }
  });

  if (response.status != 200)
    throw response.status;
};


const deleteContentItem = async (user, tableName, itemId) => {
  const item = await new Parse.Query(tableName)
    .get(itemId, {useMasterKey: true});

  if (!checkRights(user, item))
    throw "Access denied!";


  //removing MediaItem's belonging to content item
  const tableData = await getTableData(tableName);

  for (let field in tableData.fields) {
    const val = tableData.fields[field];
    if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
      const media = item.get(field);
      //!! uncontrolled async operation
      if (media)
        media.destroy({useMasterKey: true});
    }
  }


  //seeking draft version of content item
  const itemDraft = await new Parse.Query(tableName)
    .equalTo('t__owner', item)
    .first({useMasterKey: true});

  if (itemDraft) {
    if (!checkRights(user, itemDraft))
      throw "Access denied!";

    for (let field in tableData.fields) {
      const val = tableData.fields[field];
      if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
        const media = itemDraft.get(field);
        //!! uncontrolled async operation
        if (media)
          media.destroy({useMasterKey: true});
      }
    }

    await itemDraft.destroy({useMasterKey: true});
  }

  await item.destroy({useMasterKey: true});
};

const deleteModel = async (user, model, deleteRef = true, deleteModel = true) => {
  if (!checkRights(user, model))
    throw "Access denied!";


  //removing model fields
  let fields = await getAllObjects(
    new Parse.Query('ModelField')
      .equalTo('model', model)
  );

  let promises = [];
  for (let field of fields) {
    if (checkRights(user, field))
      promises.push(promisifyW(field.destroy({useMasterKey: true})));
  }
  await Promise.all(promises);


  //removing content items of model
  const tableName = model.get('tableName');
  const items = await getAllObjects(new Parse.Query(tableName));
  promises = [];
  for (let item of items) {
    promises.push(promisifyW(deleteContentItem(user, tableName, item.id)));
  }
  await Promise.all(promises);

  try {
    await deleteTable(tableName);
  } catch (e) {}


  //removing reference validation to model
  if (deleteRef) {
    const models = await getAllObjects(
      new Parse.Query('Model')
        .equalTo('site', model.get('site'))
    );
    fields = await getAllObjects(
      new Parse.Query('ModelField')
        .containedIn('model', models)
        .notEqualTo('model', model)
        .equalTo('type', 'Reference')
    );

    const promises = [];
    for (let field of fields) {
      const validations = field.get('validations');
      if (!validations || !validations.models || !validations.models.active || !validations.models.modelsList)
        continue;

      const i = validations.models.modelsList.indexOf(model.get('nameId'));
      if (i == -1)
        continue;

      validations.models.modelsList.splice(i, 1);
      field.set('validations', validations);
      promises.push(promisifyW(field.save(null, {useMasterKey: true})));
    }
    await Promise.all(promises);
  }


  //remove model
  if (deleteModel)
    await model.destroy({useMasterKey: true});
};


Parse.Cloud.define("deleteContentItem", async (request) => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {tableName, itemId} = request.params;
  if (!tableName || !itemId)
    throw 'There is no tableName or itemId params!';

  try {
    await deleteContentItem(request.user, tableName, itemId);
    return "Successfully deleted content item.";
  } catch (error) {
    throw `Could not delete content item: ${error}`;
  }
});

Parse.Cloud.beforeDelete(`Model`, async request => {
  if (request.master)
    return;

  try {
    return await deleteModel(request.user, request.object, true, false);
  } catch (error) {
    throw `Could not delete model: ${JSON.stringify(error, null, 2)}`;
  }
});

Parse.Cloud.beforeDelete(`Site`, async request => {
  if (request.master)
    return;

  const site = request.object;

  if (!checkRights(request.user, site))
    throw "Access denied!";

  //removing site's models
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  let promises = [];
  for (let model of models)
    promises.push(promisifyW(
      deleteModel(request.user, model, false)
    ));
  await Promise.all(promises);


  //removing site's collaborations
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  promises = [];
  for (let collab of collabs)
    promises.push(promisifyW(
      collab.destroy({useMasterKey: true})
    ));
  await Promise.all(promises);
});


const onCollaborationModify = async (collab, deleting = false) => {
  const site = collab.get('site');
  const user = collab.get('user');
  const role = collab.get('role');

  if (!user)
    return;

  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  let collabACL = collab.getACL();
  if (!collabACL)
    collabACL = new Parse.ACL(owner);

  //getting all site collabs
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site)
      .notEqualTo('user', user));

  for (let tempCollab of collabs) {
    if (tempCollab.id == collab.id)
      continue;

    //set ACL for others collab
    let tempCollabACL = tempCollab.getACL();
    if (!tempCollabACL)
      tempCollabACL = new Parse.ACL(owner);

    tempCollabACL.setReadAccess(user, !deleting && role == ROLE_ADMIN);
    tempCollabACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);

    tempCollab.setACL(tempCollabACL);
    //!! uncontrolled async operation
    tempCollab.save(null, {useMasterKey: true});

    //set ACL for current collab
    if (!deleting) {
      const tempRole = tempCollab.get('role');
      const tempUser = tempCollab.get('user');

      if (!tempUser)
        continue;

      collabACL.setReadAccess(tempUser, tempRole == ROLE_ADMIN);
      collabACL.setWriteAccess(tempUser, tempRole == ROLE_ADMIN);
    }
  }

  collabACL.setReadAccess(user, true);
  collabACL.setWriteAccess(user, true);
  collab.setACL(collabACL);


  //ACL for site
  let siteACL = site.getACL();
  if (!siteACL)
    siteACL = new Parse.ACL(owner);

  siteACL.setReadAccess(user, !deleting);
  siteACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
  site.setACL(siteACL);
  //!! uncontrolled async operation
  site.save(null, {useMasterKey: true});


  //ACL for media items
  const mediaItems = await getAllObjects(
    new Parse.Query('MediaItem')
      .equalTo('site', site));

  for (let item of mediaItems) {
    let itemACL = item.getACL();
    if (!itemACL)
      itemACL = new Parse.ACL(owner);

    itemACL.setReadAccess(user, !deleting);
    itemACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    item.setACL(itemACL);
    //!! uncontrolled async operation
    item.save(null, {useMasterKey: true});
  }


  //ACL for models and content items
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  for (let model of models) {
    let modelACL = model.getACL();
    if (!modelACL)
      modelACL = new Parse.ACL(owner);

    modelACL.setReadAccess(user, !deleting);
    modelACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    model.setACL(modelACL);
    //!! uncontrolled async operation
    model.save(null, {useMasterKey: true});

    const tableName = model.get('tableName');
    //!! uncontrolled async operation
    getTableData(tableName)
      .then(response => {
        let CLP = response ? response.classLevelPermissions : null;
        if (!CLP)
          CLP = {
            'get': {},
            'find': {},
            'create': {},
            'update': {},
            'delete': {},
            'addField': {}
          };

        if (!deleting) {
          CLP['get'][user.id] = true;
          CLP['find'][user.id] = true;
        } else {
          if (CLP['get'].hasOwnProperty(user.id))
            delete CLP['get'][user.id];
          if (CLP['find'].hasOwnProperty(user.id))
            delete CLP['find'][user.id];
        }

        if (!deleting && (role == ROLE_ADMIN || role == ROLE_EDITOR)) {
          CLP['create'][user.id] = true;
          CLP['update'][user.id] = true;
          CLP['delete'][user.id] = true;
        } else {
          if (CLP['create'].hasOwnProperty(user.id))
            delete CLP['create'][user.id];
          if (CLP['update'].hasOwnProperty(user.id))
            delete CLP['update'][user.id];
          if (CLP['delete'].hasOwnProperty(user.id))
            delete CLP['delete'][user.id];
        }

        if (!deleting && role == ROLE_ADMIN)
          CLP['addField'][user.id] = true;
        else if (CLP['addField'].hasOwnProperty(user.id))
          delete CLP['addField'][user.id];

        //!! uncontrolled async operation
        const data = {"classLevelPermissions": CLP};
        setTableData(tableName, data)
          .catch(() => setTableData(tableName, data, 'PUT'));
      });
  }


  //ACL for fields
  const fields = await getAllObjects(
    new Parse.Query('ModelField')
      .containedIn('model', models));

  for (let field of fields) {
    let fieldACL = field.getACL();
    if (!fieldACL)
      fieldACL = new Parse.ACL(owner);

    fieldACL.setReadAccess(user, !deleting);
    fieldACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    field.setACL(fieldACL);
    //!! uncontrolled async operation
    field.save(null, {useMasterKey: true});
  }
};


Parse.Cloud.beforeSave("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab);
});

Parse.Cloud.beforeDelete("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab, true);
});

Parse.Cloud.beforeSave(Parse.User, request => {
  const user = request.object;
  const email = user.get('email');
  if (user.get('username') != email)
    user.set('username', email);
});

Parse.Cloud.afterSave(Parse.User, async request => {
  const user = request.object;

  const collabs = await new Parse.Query('Collaboration')
    .equalTo('email', user.get('email'))
    .find({useMasterKey: true});

  const promises = [];

  for (let collab of collabs) {
    if (collab.get('user'))
      continue;

    collab.set('user', user);
    collab.set('email', '');

    promises.push(collab.save(null, {useMasterKey: true}));
    promises.push(promisifyW(onCollaborationModify(collab)));
  }

  await Promise.all(promises);
});

Parse.Cloud.beforeSave("Site", async request => {
  if (request.master)
    return;

  //updating an existing site
  if (request.object.id)
    return true;

  const user = request.user;
  if (!user)
    throw 'Must be signed in to save sites.';

  const payPlan = await getPayPlan(user);
  if (!payPlan)
    return true;

  const sitesLimit = payPlan.get('limitSites');
  if (!sitesLimit)
    return true;

  const sites = await new Parse.Query('Site')
    .equalTo('owner', user)
    .count({useMasterKey: true});

  if (sites >= sitesLimit)
    throw `The user has exhausted their sites' limit!`;

  return true;
});

Parse.Cloud.beforeSave(`Model`, async request => {
  if (request.master)
    return;

  const model = request.object;
  if (model.id)
    return;

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const modelACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  const admins = [owner.id];
  const writers = [owner.id];
  const all = [owner.id];

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    modelACL.setReadAccess(user, true);
    modelACL.setWriteAccess(user, role == ROLE_ADMIN);

    if (role == ROLE_ADMIN)
      admins.push(user.id);
    if (role == ROLE_ADMIN || role == ROLE_EDITOR)
      writers.push(user.id);
    all.push(user.id);
  }

  model.setACL(modelACL);

  //set CLP for content table
  const CLP = {
    'get': {},
    'find': {},
    'create': {},
    'update': {},
    'delete': {},
    'addField': {}
  };

  for (let user of all) {
    CLP['get'][user] = true;
    CLP['find'][user] = true;
  }
  for (let user of writers) {
    CLP['create'][user] = true;
    CLP['update'][user] = true;
    CLP['delete'][user] = true;
  }
  for (let user of admins) {
    CLP['addField'][user] = true;
  }

  const data = {"classLevelPermissions": CLP};
  await setTableData(model.get('tableName'), data);
});

Parse.Cloud.beforeSave(`ModelField`, async request => {
  if (request.master)
    return;

  const field = request.object;
  if (field.id)
    return;

  const model = field.get('model');
  await model.fetch({useMasterKey: true});

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const fieldACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    fieldACL.setReadAccess(user, true);
    fieldACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  field.setACL(fieldACL);
});

Parse.Cloud.beforeSave(`MediaItem`, async request => {
  if (request.master)
    return;

  const item = request.object;
  if (item.id)
    return;

  const site = item.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const itemACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    itemACL.setReadAccess(user, true);
    itemACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  item.setACL(itemACL);
});


Parse.Cloud.define("onContentModify", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {URL} = request.params;
  if (!URL)
    return 'Warning! There is no content hook!';

  const response = await Parse.Cloud.httpRequest({
    url: URL,
    method: 'GET'
  });

  if (response.status == 200)
    return response.data;
  else
    throw response.status;
});

Parse.Cloud.define("inviteUser", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {email, siteName} = request.params;
  if (!email || !siteName)
    throw 'Email or siteName is empty!';

  console.log(`Send invite to ${email} ${new Date()}`);

  const {AppCache} = require('parse-server/lib/cache');
  const emailAdapter = AppCache.get(config.appId)['userController']['adapter'];

  const emailSelf = request.user.get('email');
  const link = `${SITE}/sign?mode=register&email=${email}`;

  try {
    await emailAdapter.send({
      templateName: 'inviteEmail',
      recipient: email,
      variables: {siteName, emailSelf, link}
    });
    console.log(`Invite sent to ${email} ${new Date()}`);
    return "Invite email sent!";

  } catch (error) {
    console.error(`Got an error in inviteUser: ${error}`);
    throw error;
  }
});

Parse.Cloud.define("checkPassword", request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {password} = request.params;
  if (!password)
    throw 'There is no password param!';

  const username = request.user.get('username');

  return Parse.User.logIn(username, password);
});


// Get Site nameId to generate Model names
const getSiteNameId = async(siteId) => {
  const siteQuery = new Parse.Query('Site');
  siteQuery.equalTo('objectId', siteId);
  const siteRecord = await siteQuery.first({useMasterKey: true});
  if (!siteRecord || !siteRecord.get('nameId')) return null;
  return siteRecord.get('nameId');
}

Parse.Cloud.define("getSiteNameId", async (request) => {
  const { siteId } = request.params;
  try {
    const siteNameId = await getSiteNameId(siteId);
    
    return { status: 'success', siteNameId };
  } catch (error) {
    console.error('inside getSiteNameId', error);
    return { status: 'error', error };
  }
});


Parse.Cloud.define("getAppsList", async (request) => {
  const { siteId, filter: { developer = [], status } } = request.params;
  try {
    const apps = await getAppsList(siteId, developer, status);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getAppsList', error);
    return { status: 'error', error };
  }
});

const getAppsList = async(siteId, developerIds, status) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Catgories']);
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include(['Data.Capabilities']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');


    query.include('Developer');
    query.include('Security');

    

    if (developerIds && developerIds.length > 0) {
      const developersQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
      developersQuery.containedIn('objectId', developerIds);
      query.matchesQuery('Developer', developersQuery);
    }
    

    if (!!status) {
      const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
      readyForSaleQuery.equalTo('Status', status);
      query.matchesQuery('Data', readyForSaleQuery);
    }
    
    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {  
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        id: appObject._getId(),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        // siteInfo,
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getPublicAppsList', error);
    throw error;
  }
}


Parse.Cloud.define("getPluginsList", async (request) => {
  const { siteId, filter: { developer = [], status } } = request.params;
  try {
    const apps = await getPluginsList(siteId, developer, status);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getPluginsList', error);
    return { status: 'error', error };
  }
});

const getPluginsList = async(siteId, developerIds, status) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include(['Data.Capabilities']);
    query.include('Content');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Catgories']);
    query.include('Security');   

    if (developerIds && developerIds.length > 0) {
      const developersQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
      developersQuery.containedIn('objectId', developerIds);
      query.matchesQuery('Developer', developersQuery);
    }
    

    if (!!status) {
      const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
      readyForSaleQuery.equalTo('Status', status);
      query.matchesQuery('Data', readyForSaleQuery);
    }
    
    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {  
      // const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        id: appObject._getId(),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer: appObject.get('Developer'),
        // developer,
        developerContent,
        developerData,
      });
    }
    return lst;

  } catch(error) {
    console.error('inside getPluginList', error);
    throw error;
  }
}



Parse.Cloud.define("publishedAppsList", async (request) => {
  const { siteId } = request.params;
  try {
    const publishedApps = await getPublishedAppsList(siteId);
    
    return { status: 'success', apps: publishedApps };
  } catch (error) {
    console.error('inside publishedAppsList', error);
    return { status: 'error', error };
  }
});

const getPublishedAppsList = async(siteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Catgories']);
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include(['Data.Capabilities']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');


    query.include('Developer');
    query.include('Security');
    
    const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    readyForSaleQuery.equalTo('Status', 'Ready for Sale');
    query.matchesQuery('Data', readyForSaleQuery);
    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {  
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        id: appObject._getId(),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getPublicAppsList', error);
    throw error;
  }
}


Parse.Cloud.define("featuredAppsList", async (request) => {
  const { siteId } = request.params;
  try {
    const featuredApps = await getFeaturedAppsList(siteId);
    
    return { status: 'success', apps: featuredApps };
  } catch (error) {
    console.error('inside featuredAppsList', error);
    return { status: 'error', error };
  }
});

const getFeaturedAppsList = async(siteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    query.include(['Data.Dashboard_Setting']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');
    
    const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    readyForSaleQuery.equalTo('Status', 'Ready for Sale');
    query.matchesQuery('Data', readyForSaleQuery);

    const featuredQuery = new Parse.Query(DEVELOPER_APP_CONTENT_MODEL_NAME);
    featuredQuery.equalTo('Featured_', true);
    query.matchesQuery('Content', featuredQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        id: appObject._getId(),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getFeaturedAppsList', error);
    throw error;
  }
}

Parse.Cloud.define("appsMadeBy", async (request) => {
  const { siteId, companyName } = request.params;
  try {
    const apps = await getAppsListMadeBy(siteId, companyName);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside appsMadeBy', error);
    return { status: 'error', error };
  }
});

const getAppsListMadeBy = async(siteId, companyName) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    
    const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    readyForSaleQuery.equalTo('Status', 'Ready for Sale');
    query.matchesQuery('Data', readyForSaleQuery);

    const madeByQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    madeByQuery.equalTo('Company', companyName);
    query.matchesQuery('Developer', madeByQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        // siteInfo
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getAppsListMadeBy function', error);
    throw error;
  }
}


Parse.Cloud.define("categoryAppsList", async (request) => {
  const { siteId, categorySlug } = request.params;
  try {
    const apps = await getCategoryAppsList(siteId, categorySlug);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside categoryAppsList', error);
    return { status: 'error', error };
  }
});

const getCategoryAppsList = async(siteId, categorySlug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;
    const CATEGORY_MODEL_NAME = `ct____${siteNameId}____Category`;

    const categoryQuery = new Parse.Query(CATEGORY_MODEL_NAME);
    categoryQuery.equalTo('t__status', 'Published');
    categoryQuery.equalTo('Slug', categorySlug);
    const categoryObject = await categoryQuery.first({ useMasterKey: true });

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    
    const categoriesMatchQuery = new Parse.Query(DEVELOPER_APP_CONTENT_MODEL_NAME);
    categoriesMatchQuery.equalTo('Categories', categoryObject);
    query.matchesQuery('Content', categoriesMatchQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      lst.push({
	      id: appObject._getId(),
        name: appObject.get('Name'),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        // siteInfo
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getCategoryAppsList', error);
    throw error;
  }
}


Parse.Cloud.define("searchApps", async (request) => {
  const { siteId, keyword } = request.params;
  try {
    const apps = await searchApps(siteId, keyword);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside searchApps', error);
    return { status: 'error', error };
  }
});

const searchApps = async(siteId, keyword) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.matches('Name', keyword, 'i')
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    
    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      const security = getSecurityFromAppObject(appObject);
      lst.push({
	      id: appObject._getId(),
        name: appObject.get('Name'),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        security,
        // siteInfo
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside searchApps', error);
    throw error;
  }
}



Parse.Cloud.define("getAppDetail", async (request) => {
  const { siteId, appSlug } = request.params;
  try {
    const appDetail = await getAppDetail(siteId, appSlug);
    
    return { status: 'success', appDetail };
  } catch (error) {
    console.error('inside getAppDetail', error);
    return { status: 'error', error };
  }
});

const getAppDetail = async(siteId, appSlug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('Slug', appSlug)
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Categories']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    
    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return null;
    const developer = getDeveloperFromAppObject(appObject);
    const developerContent = getDeveloperContentFromAppObject(appObject);
    const developerData = await getDeveloperDataFromAppObject(appObject);
    const developerSecurity = getSecurityFromAppObject(appObject);
    const siteInfo = await getSiteInfoFromAppObject(appObject);
    return {
      id: appObject.id,
      name: appObject.get('Name'),
      slug: appObject.get('Slug'),
      url: appObject.get('URL'),
      developer,
      developerContent,
      developerData,
      developerSecurity,
      siteInfo
    }
  } catch(error) {
    console.error('inside getAppDetal', error);
    throw error;
  }
}

Parse.Cloud.define("getDeveloperAppByIds", async (request) => {
  const { siteId, appIds } = request.params;
  try {
    const apps = await Promise.all(appIds.map(appId => getDeveloperAppById(siteId, appId)));
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getDeveloperAppById', error);
    return { status: 'error', error };
  }
});


Parse.Cloud.define("getDeveloperAppById", async (request) => {
  const { siteId, appId } = request.params;
  try {
    const appDetail = await getDeveloperAppById(siteId, appId);
    
    return { status: 'success', appDetail };
  } catch (error) {
    console.error('inside getDeveloperAppById', error);
    return { status: 'error', error };
  }
});

const getDeveloperAppById = async(siteId, appId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('objectId', appId)
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Categories']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    query.include(['Data.Capabilities']);
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');

    
    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return null;
    const developer = getDeveloperFromAppObject(appObject);
    const developerContent = getDeveloperContentFromAppObject(appObject);
    const developerData = await getDeveloperDataFromAppObject(appObject);
    const developerSecurity = getSecurityFromAppObject(appObject);
    // const siteInfo = await getSiteInfoFromAppObject(appObject);
    return {
      id: appObject._getId(),
      name: appObject.get('Name'),
      slug: appObject.get('Slug'),
      url: appObject.get('URL'),
      developer,
      developerContent,
      developerData,
      developerSecurity,
      // siteInfo
    }
  } catch(error) {
    console.error('inside getDeveloperAppById', error);
    throw error;
  }
}



function getDeveloperFromAppObject(appObject) {
  let developer = null;
  const developerObject = appObject.get('Developer');

  if (developerObject && developerObject.length > 0) {
    developer = {
      id: developerObject[0].id,
      name: developerObject[0].get('Name'),
      verified: developerObject[0].get('Verified') || false,
      company: developerObject[0].get('Company') || '',
      website: developerObject[0].get('Website') || '',
      email: developerObject[0].get('Email') || '',
      isActive: developerObject[0].get('IsActive') || false,
    }
  }
  return developer;
}

function getDeveloperContentFromAppObject(appObject) {
  let developerContent = null;
  const developerContentObject = appObject.get('Content');
  if (developerContentObject && developerContentObject.length > 0) {
    let screenshots = [];
    if (developerContentObject[0].get('Screenshots') && developerContentObject[0].get('Screenshots').length > 0) {
      screenshots = developerContentObject[0].get('Screenshots').map(screen => screen.get('file')._url);
    }
    let categories = [];
    if (developerContentObject[0].get('Categories') && developerContentObject[0].get('Categories').length > 0) {
      categories = developerContentObject[0].get('Categories').map(category => ({
        name: category.get('Name'),
        slug: category.get('Slug'),
        id: category.id
      }))
    }
    developerContent = {
      id: developerContentObject[0].id,
      shortName: developerContentObject[0].get('Short_Name'),
      keyImage: developerContentObject[0].get('Key_Image') ? developerContentObject[0].get('Key_Image').get('file')._url : null,
      description: developerContentObject[0].get('Description') || '',
      termsURL: developerContentObject[0].get('Terms_URL') || '',
      privacyURL: developerContentObject[0].get('Privacy_URL') || '',
      featured: developerContentObject[0].get('Featured_') || false,
      listing: developerContentObject[0].get('Listing') || [],
      filters: developerContentObject[0].get('Filters') || [],
      categories,
      screenshots
    }
  }
  return developerContent;
}


async function getDeveloperDataFromAppObject(appObject) {
  let developerData = null;
  const developerDataObject = appObject.get('Data');

  if (developerDataObject && developerDataObject.length > 0) {    
    let dashboardSettings = null;

    if (developerDataObject[0].get('Dashboard_Setting') && developerDataObject[0].get('Dashboard_Setting').length > 0) {
      dashboardSettings = developerDataObject[0].get('Dashboard_Setting')[0];
    }

    developerData = {
      id: developerDataObject[0].id,
      dataName: developerDataObject[0].get('Data_Name'),
      installsCount: developerDataObject[0].get('Installs_Count'),
      status: developerDataObject[0].get('Status'),
      rating: developerDataObject[0].get('Rating'),
      isPaid: developerDataObject[0].get('Is_Paid_') || false,
      feeType: developerDataObject[0].get('Fee_Type') || null,
      feeAmount: developerDataObject[0].get('Fee_Amount') || null,
      capabilities: developerDataObject[0].get('Capabilities') || null,
      facilitatorMode: developerDataObject[0].get('Facilitator_Mode') || null,
      permissions: developerDataObject[0].get('Permissions') || [],
      sandboxPermissions: developerDataObject[0].get('Sandbox_Permissions') || [],
      dashboardSettings,
    }
  }
  return developerData;
}

// Get site info from app object / security
async function getSiteInfoFromAppObject(appObject) {
  try {
    const securityObject = appObject.get('Security');
    if (securityObject && securityObject[0] && securityObject[0].get('Forge_API_Key')) {
      const url = 'https://getforge.com/api/v2/settings/site_info?site_token=' + securityObject[0].get('Forge_API_Key');
      const result = await axios.get(url);
      return result.data ? result.data.message : null;
    }
    return null
  } catch(error) {
    console.error("inside getSiteInfoFromAppObject", error);
    // throw error;
    return null;
  }
}

function getSecurityFromAppObject(appObject) {
  try {
    let security = null;
    const securityObject = appObject.get('Security');
    if (securityObject && securityObject.length > 0) {
      const policy = securityObject[0].get('Policy');
      if (policy) {
        security = {
          id: policy[0].id,
          name: policy[0].get('Policy_Name'),
          evalSafePassMax: policy[0].get('EvalSafe_Pass_Max'),
          evalSafePassMin: policy[0].get('EvalSafe_Pass_Min'),
          evalSafeWarningMax: policy[0].get('EvalSafe_Warning_Max'),
          evalSafeWarningMin: policy[0].get('EvalSafe_Warning_Min'),
          evalSafeFailMax: policy[0].get('EvalSafe_Fail_Max'),
          evalSafeFailMin: policy[0].get('EvalSafe_Fail_Min'),
          requireSSL: policy[0].get('RequireSSL'),
          requireForceSSL: policy[0].get('RequireForceSSL')
        };
      }
    }
    return security;
  } catch(error) {
    console.error("get security", error);
  }
}


Parse.Cloud.define("getDeveloperFromUserId", async (request) => {
  const { siteId, userId } = request.params;
  try {
    const developer = await getDeveloperFromUserId(siteId, userId);
    const isMuralAdmin = await checkIfMuralAdmin(userId);
    return { status: 'success', developer, isMuralAdmin };
    // return { status: 'success', isMuralAdmin };
  } catch (error) {
    console.error('inside getDeveloperFromUserId', error);
    return { status: 'error', error };
  }
});

const getDeveloperFromUserId = async(siteId, userId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // get site name Id and generate MODEL names based on that
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;
    developerQuery.equalTo('user', currentUser);
    developerQuery.equalTo('IsActive', true);
    const developerObject = await developerQuery.first();
    
    if (!developerObject) return null;
    
    return {
      id: developerObject.id,
      name: developerObject.get('Name'),
      verified: developerObject.get('Verified') || false,
      company: developerObject.get('Company') || '',
      website: developerObject.get('Website') || '',
      email: developerObject.get('Email') || '',
      isActive: developerObject.get('IsActive') || false,
    };

  } catch(error) {
    console.error('inside getDeveloperFromUserId', error);
    throw error;
  }
}




const checkIfMuralAdmin = async(userId) => {
  try {
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;

    const roleQuery = new Parse.Query(Parse.Role);
    roleQuery.equalTo('name', 'Mural Admins');
    const roleObject = await roleQuery.first();

    const adminRelation = new Parse.Relation(roleObject, 'users');
    const queryAdmins = adminRelation.query();
    const userObjects = await queryAdmins.find();
    for (const userObject of userObjects) {
      if (userObject.id.toString() === userId) return true;
    }
    return false;
  } catch(error) {
    console.error('inside checkIfMuralAdmin', error);
    throw error;
  }
}

Parse.Cloud.define("authorize", async (request) => {
  const { params } = request;
  const authorizationUri = 'https://app.mural.co/api/public/v1/authorization/oauth2/';
  try {
    const query = new URLSearchParams();
    query.set('client_id', process.env.MURAL_CLIENT_ID);
    query.set('redirect_uri', getMuralRedirectURI(params.devMode));
    query.set('state', 123);
    query.set('response_type', 'code');
    const scopes = [
      "identity:read"
    ]
    query.set('scope', scopes.join(' '));
	  return { success: true, url: `${authorizationUri}?${query}`};
  } catch(error) {
    console.error('inside authorize', error);
    return { success: false, error };
  }
});

Parse.Cloud.define("token", async (request) => {
  try {
    const { params } = request;
    const redirect_uri = getMuralRedirectURI(params.devMode);
    const response = await axios.post('https://app.mural.co/api/public/v1/authorization/oauth2/token', 
      {
        client_id: process.env.MURAL_CLIENT_ID,
        client_secret: process.env.MURAL_CLIENT_SECRET,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri
      });
    if (response.status!== 200) {
      throw 'token request failed';
    }
    const meResponse = await axios.get('https://app.mural.co/api/public/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${response.data.access_token}`
      }
    });
    if (meResponse.status !== 200) {
      throw 'unauthorized for getting currentUser';
    }
    return {
      success: true,
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      me: meResponse.data.value
    };
    
  } catch(error) {
    console.error("inside token", error);
    return { success: false, error };
  }
});


Parse.Cloud.define("refresh", async (request) => {
  try {
    const { params } = request;
    const { refreshToken } = params;
    const response = await axios.post('https://app.mural.co/api/public/v1/authorization/oauth2/refresh', 
      {
        client_id: process.env.MURAL_CLIENT_ID,
        client_secret: process.env.MURAL_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      });
    if (response.status!== 200) {
      throw 'token request failed';
    }
    return {
      success: true,
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    };
    
  } catch(error) {
    console.error("inside refresh", error);
    return { success: false, error };
  }
});


Parse.Cloud.define("getPublisherSettings", async (request) => {
  const { siteId } = request.params;
  try {
    const publisherSetting = await getPublisherSettings(siteId);
    
    
    return { status: 'success', publisherSetting };
  } catch (error) {
    console.error('inside getPublisherSettings', error);
    return { status: 'error', error };
  }
});

const getPublisherSettings = async(siteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const PUBLISHER_SETTING_MODEL_NAME = `ct____${siteNameId}____Publisher_Settings`;

    const query = new Parse.Query(PUBLISHER_SETTING_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Logo');
    
    const publisherSettingObject = await query.first({ useMasterKey: true });
    if (!publisherSettingObject) return null;
    return {
      name: publisherSettingObject.get('Name'),
      logo: publisherSettingObject.get('Logo') ? publisherSettingObject.get('Logo').get('file')._url : '',
      primaryColor: publisherSettingObject.get('Primary_Colour'),
      secondaryColor: publisherSettingObject.get('Secondary_Colour'),
      appsListBanner: publisherSettingObject.get('Apps_List_Banner') ? publisherSettingObject.get('Logo').get('file')._url : ''
    };
  } catch(error) {
    console.error('inside getPublisherSettings function', error);
    throw error;
  }
}

const getMuralRedirectURI = (devMode) => {
  return devMode ? process.env.DEV_MURAL_REDIRECT_URI : process.env.MURAL_REDIRECT_URI;
}

// Related with Mural Auth
Parse.Cloud.define('linkWith', async(request) => {
  const { authData, email } = request.params;
  try {
    let user;
    // Check for existing user with email given from `token` request response
    const userQuery = new Parse.Query('User');
    userQuery.equalTo('email', email)
    user = await userQuery.first();
    const oldId = user ? user.id : null;

    if (!user) user = new Parse.User();
    await user.linkWith('mural', { authData }, { useMasterKey: true });
    
    // set username and email for the new user
    if (!oldId) {
      await user.save({ 
        'username': email, 
        'email': email
      }, 
      { useMasterKey: true });
    }
    return { status: 'success', user };
  } catch (error) {
    console.error('inside linkWith', error);
    return { status: 'error', error };
  }
})

// Related with Mural Auth
Parse.Cloud.define('activateDeveloper', async(request) => {
  try {
    const { siteId, userId, developerId } = request.params;
    const developer = await activateDeveloper(siteId, userId, developerId);
    return { status: 'success', developer };
  } catch (error) {
    console.error('inside activateDeveloper', error);
    return { status: 'error', error };
  }
});

const activateDeveloper = async(siteId, userId, developerId) => {
  try {
    let i;
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // Model related data preparation
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;

    // 
    const DeveloperModel = Parse.Object.extend(DEVELOPER_MODEL_NAME);
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('user', currentUser);
    const results = await developerQuery.find();
    for (i = 0; i < results.length; i++) {
      if (results[i].id !== developerId) {
        const updatedDeveloper = new DeveloperModel();
        updatedDeveloper.id = results[i].id;
        updatedDeveloper.set('IsActive', false);
        await updatedDeveloper.save();
      }
    }

    const currentDeveloperQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    currentDeveloperQuery.equalTo('objectId', developerId);
    const currentDeveloper = await currentDeveloperQuery.first();
    currentDeveloper.set('IsActive', true);
    await currentDeveloper.save();

    return {
      id: currentDeveloper.id,
      name: currentDeveloper.get('Name'),
      verified: currentDeveloper.get('Verified') || false,
      company: currentDeveloper.get('Company') || '',
      website: currentDeveloper.get('Website') || '',
      email: currentDeveloper.get('Email') || '',
      isActive: currentDeveloper.get('IsActive') || false,
    };

  } catch(error) {
    console.error("inside activateDeveloper function", error);
    throw error;
  }
}


// Related with Mural Auth
Parse.Cloud.define('developersList', async(request) => {
  try {
    const { siteId, verified } = request.params;
    const developersList = await getDevelopersList(siteId, verified);
    return { status: 'success', developersList };
  } catch (error) {
    console.error('inside developersList', error);
    return { status: 'error', error };
  }
});

const getDevelopersList = async(siteId, verified) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // Model related data preparation
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('t__status', 'Published');
    if (!!verified && verified !== '') {
      developerQuery.equalTo('Verified', verified);
    }
    const results = await developerQuery.find();

    const list = results.map(developer => (
      {
        id: developer.id,
        slug: developer.get('Slug') || '',
        name: developer.get('Name'),
        verified: developer.get('Verified') || false,
        company: developer.get('Company') || '',
        website: developer.get('Website') || '',
        email: developer.get('Email') || '',
        isActive: developer.get('IsActive') || false,
        updatedAt: developer.get('updatedAt')
      }
    ));
    return list;

  } catch(error) {
    console.error("inside getDevelopersList function", error);
    throw error;
  }
}



Parse.Cloud.define("getDeveloperDetailBySlug", async (request) => {
  const { siteId, slug } = request.params;
  try {
    const developer = await getDeveloperDetailBySlug(siteId, slug);
    return { status: 'success', developer };
  } catch (error) {
    console.error('inside getDeveloperDetailBySlug', error);
    return { status: 'error', error };
  }
});

const getDeveloperDetailBySlug = async(siteId, slug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // get site name Id and generate MODEL names based on that
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('Slug', slug);
    developerQuery.equalTo('t__status', 'Published');
    const developerObject = await developerQuery.first();
    
    if (!developerObject) return null;
    
    const appsList = await getAppsListByDeveloperSlug(siteId, slug);

    return {
      id: developerObject.id,
      name: developerObject.get('Name'),
      verified: developerObject.get('Verified') || false,
      company: developerObject.get('Company') || '',
      website: developerObject.get('Website') || '',
      email: developerObject.get('Email') || '',
      isActive: developerObject.get('IsActive') || false,
      appsList
    };

  } catch(error) {
    console.error('inside getDeveloperDetailBySlug', error);
    throw error;
  }
}


const getAppsListByDeveloperSlug = async(siteId, slug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(siteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    
    const madeByQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    madeByQuery.equalTo('Slug', slug);
    query.matchesQuery('Developer', madeByQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const lst = [];
    for (const appObject of appObjects) {    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getDeveloperContentFromAppObject(appObject);
      const developerData = await getDeveloperDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      lst.push({
        name: appObject.get('Name'),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        // siteInfo
      });
    }
    return lst.sort((a, b) => (a.name > b.name ? 1 : -1));

  } catch(error) {
    console.error('inside getAppsListByDeveloperSlug function', error);
    throw error;
  }
}
