# IoT Catalogue external service

Allows the communication between a node application and IoT Catalogue through a queue, and data subscription.

## Connection

Provide the following parameters to establish a connection between Node app and IoT Catalogue
* **socketAddress:** URL of IoT Catalogue instance
* **token:** Token used for user authentication
* **serviceDescription (optional):** Object describing what external service can offer
* **connectionProps (optional):** Props related with the connection, currently supported option:
  * **dataFields:** Which fields must be returned from a data subscription

## Examples

### PDF Exporter service

```js
const pdfExporterUserToken = "xxx"

const connection = new Connection("https://www.iot-catalogue.com",pdfExporterUserToken,{documentType:"pdf"})

connection.onSubscribedToService((res)=>{
	console.log("subscribedToService")
	console.log(res) //{ serviceFound: true, props: { repositoryType: 'github' }, name: 'analyse github'}
})

connection.on("actionAdded",(obj,callback)=>{
    console.log("actionAdded", obj) // {action:"generatePDF",id:"xyz",collection:"components"};
    const s3URL = generatePDF(obj);
    callback({s3URL}) // Info sent to IoT Catalogue

})

```

### Data subscription

```js
const userWithDataAccess = "xxx"

const connection = new Connection("https://www.iot-catalogue.com",userWithDataAccess,undefined,{dataFields:{name:1}})

connection.onDataChange((collectionName, obj)=>{
    console.log(collectionName) //components
    console.log(obj) //{added: [...], changed: [...], removed:[...]}
})


```
